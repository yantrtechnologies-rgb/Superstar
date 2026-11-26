import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './client';
import { publishInstagramMedia } from './instagram-publish';
import { metaConfiguration } from './meta-connection';
import { type OAuthProviderAdapter, ProviderConfigurationError, type PublishingImage, type PublishResult } from './provider-contract';
import { openToken } from './token-vault';

const graphError = z.object({ error: z.object({
  message: z.string().optional(), code: z.number().optional(), is_transient: z.boolean().optional(),
}).optional() });

async function credentials(provider: 'facebook' | 'instagram', channelId: string, workspaceId: string) {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, workspaceId, provider }, include: { credential: true },
  });
  const stored = channel?.credential;
  if (!channel || !stored || stored.revokedAt || (stored.accessExpiresAt && stored.accessExpiresAt <= new Date())) {
    throw new ProviderConfigurationError(`The ${provider === 'facebook' ? 'Facebook Page' : 'Instagram'} authorization expired. Reconnect it.`);
  }
  return openToken(stored.accessToken, `${provider}/${workspaceId}/${channelId}/access`);
}

async function request(path: string, token: string, body?: URLSearchParams | FormData, options: { video?: boolean } = {}) {
  const config = metaConfiguration();
  if (!config) throw new ProviderConfigurationError('Meta publishing is not configured.');
  // Video uploads go to Meta's video host and can take a while for a 20 MB file.
  const url = new URL(`https://${options.video ? 'graph-video' : 'graph'}.facebook.com/${config.version}/${path}`);
  url.searchParams.set('appsecret_proof', createHmac('sha256', config.secret).update(token).digest('hex'));
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET', body, headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(options.video ? 150_000 : 20_000),
    });
  } catch {
    return { kind: 'uncertain', error: 'Meta did not confirm whether the publishing request completed. Check the account before retrying.' } as const;
  }
  const json: unknown = await response.json().catch(() => ({}));
  if (response.ok) return { kind: 'ok', json } as const;
  const parsed = graphError.safeParse(json);
  const error = parsed.success ? parsed.data.error : undefined;
  if (error?.code === 190 || error?.code === 200) {
    return { kind: 'failed', error: 'Meta denied publishing access. Reconnect the account and grant publishing permission.' } as const;
  }
  if (error?.is_transient || [1, 2, 4, 17, 32, 613, 80001].includes(error?.code ?? 0)) {
    return { kind: 'retry', delayMs: 60_000 } as const;
  }
  return { kind: 'failed', error: error?.message ? `Meta rejected the post: ${error.message}` : 'Meta rejected the post.' } as const;
}

function published(json: unknown, permalink: (id: string) => string | null): PublishResult {
  const parsed = z.object({ id: z.string().min(1), post_id: z.string().min(1).optional() }).safeParse(json);
  if (!parsed.success) return { kind: 'uncertain', error: 'Meta accepted the request without returning a publication identifier.' };
  const id = parsed.data.post_id ?? parsed.data.id;
  return { kind: 'published', externalId: id, permalink: permalink(id) };
}

/** Sends a video's bytes to the upload URL Meta returned when a Reel or video Story upload started. */
async function uploadVideo(uploadUrl: string, token: string, bytes: Uint8Array<ArrayBuffer>) {
  if (!/^https:\/\/rupload\.facebook\.com\//.test(uploadUrl)) return false;
  try {
    const response = await fetch(uploadUrl, {
      method: 'POST', body: bytes, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(150_000),
      headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(bytes.byteLength) },
    });
    const json = await response.json().catch(() => ({})) as { success?: boolean };
    return response.ok && json.success === true;
  } catch {
    return false;
  }
}

/** Starts a Reel or video Story upload, sends the video, and returns its id (start → upload → finish). */
async function startVideoUpload(pageId: string, edge: 'video_reels' | 'video_stories', token: string, video: PublishingImage) {
  const started = await request(`${pageId}/${edge}`, token, new URLSearchParams({ upload_phase: 'start' }));
  if (started.kind !== 'ok') return started.kind === 'uncertain' ? { kind: 'failed', error: 'Meta did not confirm the video upload started; nothing was published.' } as const : started;
  const session = z.object({ video_id: z.string().min(1), upload_url: z.url() }).safeParse(started.json);
  if (!session.success) return { kind: 'failed', error: 'Meta did not return an upload session; nothing was published.' } as const;
  if (!await uploadVideo(session.data.upload_url, token, video.bytes)) {
    return { kind: 'failed', error: 'Meta did not accept the video upload; nothing was published.' } as const;
  }
  return { kind: 'uploaded', id: session.data.video_id } as const;
}

async function facebookReel(pageId: string, token: string, content: string, video: PublishingImage): Promise<PublishResult> {
  const uploaded = await startVideoUpload(pageId, 'video_reels', token, video);
  if (uploaded.kind !== 'uploaded') return uploaded;
  const finished = await request(`${pageId}/video_reels`, token, new URLSearchParams({
    upload_phase: 'finish', video_id: uploaded.id, video_state: 'PUBLISHED', description: content,
  }));
  if (finished.kind !== 'ok') return finished.kind === 'uncertain'
    ? { kind: 'uncertain', error: 'Meta did not confirm the Reel was published. Check the Page before retrying.' } : finished;
  return { kind: 'published', externalId: uploaded.id, permalink: `https://www.facebook.com/reel/${uploaded.id}` };
}

async function facebookStory(pageId: string, token: string, item: PublishingImage): Promise<PublishResult> {
  let finished: Awaited<ReturnType<typeof request>>;
  if (item.type === 'video/mp4') {
    const uploaded = await startVideoUpload(pageId, 'video_stories', token, item);
    if (uploaded.kind !== 'uploaded') return uploaded;
    finished = await request(`${pageId}/video_stories`, token, new URLSearchParams({ upload_phase: 'finish', video_id: uploaded.id }));
  } else {
    // A photo Story is an unpublished photo, then posted to the Page's Stories.
    const form = new FormData();
    form.set('published', 'false');
    form.set('source', new Blob([item.bytes], { type: item.type }), item.type === 'image/png' ? 'story.png' : 'story.jpg');
    const photo = await request(`${pageId}/photos`, token, form);
    if (photo.kind !== 'ok') return photo.kind === 'uncertain' ? { kind: 'failed', error: 'Meta did not confirm the photo upload; nothing was published.' } : photo;
    const id = z.object({ id: z.string().min(1) }).safeParse(photo.json);
    if (!id.success) return { kind: 'failed', error: 'Meta did not return a photo identifier; nothing was published.' };
    finished = await request(`${pageId}/photo_stories`, token, new URLSearchParams({ photo_id: id.data.id }));
  }
  if (finished.kind !== 'ok') return finished.kind === 'uncertain'
    ? { kind: 'uncertain', error: 'Meta did not confirm the Story was published. Check the Page before retrying.' } : finished;
  const story = z.object({ post_id: z.string().min(1) }).safeParse(finished.json);
  return story.success
    ? { kind: 'published', externalId: story.data.post_id, permalink: null }
    : { kind: 'uncertain', error: 'Meta accepted the Story without returning an identifier.' };
}

export const facebook: OAuthProviderAdapter = {
  kind: 'oauth', name: 'Facebook Page', textLimit: 63_206, imageCaptionLimit: 63_206, maxImages: 10, acceptsVideo: true,
  formats: ['reel', 'story'],
  connectionHelp: 'Connect a Facebook Page and grant pages_manage_posts.', configured: () => Boolean(metaConfiguration()),
  async publish(_workspace, channel, _nonce, content, image, images, options) {
    const token = await credentials('facebook', channel.id, channel.workspaceId);
    if (options?.format === 'reel') {
      if (image?.type !== 'video/mp4') return { kind: 'failed', error: 'A Facebook Reel needs an MP4 video.' };
      return facebookReel(channel.externalId, token, content, image);
    }
    if (options?.format === 'story') {
      if (!image) return { kind: 'failed', error: 'A Facebook Story needs a photo or video.' };
      return facebookStory(channel.externalId, token, image);
    }
    if (image?.type === 'video/mp4') {
      // A video post: the MP4 is uploaded to the Page's videos with the post text as its description.
      const form = new FormData();
      form.set('description', content); form.set('published', 'true');
      form.set('source', new Blob([image.bytes], { type: 'video/mp4' }), 'video.mp4');
      const uploaded = await request(`${channel.externalId}/videos`, token, form, { video: true });
      if (uploaded.kind !== 'ok') return uploaded;
      const parsed = z.object({ id: z.string().min(1) }).safeParse(uploaded.json);
      return parsed.success
        ? { kind: 'published', externalId: parsed.data.id, permalink: `https://www.facebook.com/watch/?v=${parsed.data.id}` }
        : { kind: 'uncertain', error: 'Facebook accepted the video without returning an identifier.' };
    }
    const photos = (images ?? []).filter((item) => item.type.startsWith('image/'));
    if (photos.length > 1) {
      // Upload each photo unpublished, then publish one feed post that attaches them all.
      const ids: string[] = [];
      for (const [index, photo] of photos.slice(0, 10).entries()) {
        const form = new FormData();
        form.set('published', 'false');
        form.set('source', new Blob([photo.bytes], { type: photo.type }), `image-${index}.${photo.type === 'image/png' ? 'png' : 'jpg'}`);
        const uploaded = await request(`${channel.externalId}/photos`, token, form);
        if (uploaded.kind !== 'ok') {
          return uploaded.kind === 'uncertain' ? { kind: 'failed', error: 'Meta did not confirm a photo upload; nothing was published.' } : uploaded;
        }
        const id = z.object({ id: z.string().min(1) }).safeParse(uploaded.json);
        if (!id.success) return { kind: 'failed', error: 'Meta did not return a photo identifier; nothing was published.' };
        ids.push(id.data.id);
      }
      const body = new URLSearchParams({ message: content, published: 'true' });
      ids.forEach((id, index) => body.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: id })));
      const result = await request(`${channel.externalId}/feed`, token, body);
      return result.kind === 'ok' ? published(result.json, (id) => `https://www.facebook.com/${id}`) : result;
    }
    if (image) {
      const form = new FormData();
      form.set('caption', content); form.set('published', 'true');
      form.set('source', new Blob([image.bytes], { type: image.type }), image.type === 'image/png' ? 'image.png' : 'image.jpg');
      const result = await request(`${channel.externalId}/photos`, token, form);
      return result.kind === 'ok' ? published(result.json, (id) => `https://www.facebook.com/${id}`) : result;
    }
    const result = await request(`${channel.externalId}/feed`, token, new URLSearchParams({ message: content, published: 'true' }));
    return result.kind === 'ok' ? published(result.json, (id) => `https://www.facebook.com/${id}`) : result;
  },
  async reply(_workspace, channel, _nonce, content, parentId) {
    // Commenting as the Page needs the pages_manage_engagement permission in addition to pages_manage_posts.
    const token = await credentials('facebook', channel.id, channel.workspaceId);
    const result = await request(`${parentId}/comments`, token, new URLSearchParams({ message: content }));
    if (result.kind === 'failed' && result.error.startsWith('Meta denied')) {
      return { kind: 'failed', error: 'Facebook refused the comment. Add the pages_manage_engagement permission to the Meta login configuration, then reconnect the Page.' };
    }
    if (result.kind !== 'ok') return result;
    const parsed = z.object({ id: z.string().min(1) }).safeParse(result.json);
    return parsed.success
      ? { kind: 'published', externalId: parsed.data.id, permalink: `https://www.facebook.com/${parentId}?comment_id=${parsed.data.id.split('_').pop()}` }
      : { kind: 'uncertain', error: 'Meta accepted the comment without returning an identifier.' };
  },
};

export const instagram: OAuthProviderAdapter = {
  kind: 'oauth', name: 'Instagram professional account', textLimit: 2_200, imageCaptionLimit: 2_200,
  // A photo, a carousel of up to 10 photos and videos, or one MP4 published as a Reel.
  requiresImage: true, acceptsVideo: true, maxImages: 10, formats: ['story'],
  connectionHelp: 'Connect a professional Instagram account linked to a Facebook Page.', configured: () => Boolean(metaConfiguration()),
  async publish(_workspace, channel, _nonce, content, image, images, options) {
    const token = await credentials('instagram', channel.id, channel.workspaceId);
    return publishInstagramMedia((path, body) => request(path, token, body), channel.externalId, content, images ?? (image ? [image] : []), options?.format);
  },
};

/** Used by the comments inbox (comments.ts). */
export { credentials as metaCredentials, request as metaRequest };
