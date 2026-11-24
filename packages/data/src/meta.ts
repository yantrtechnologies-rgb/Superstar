import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './client';
import { metaConfiguration } from './meta-connection';
import { type OAuthProviderAdapter, ProviderConfigurationError, type PublishResult } from './provider-contract';
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

export const facebook: OAuthProviderAdapter = {
  kind: 'oauth', name: 'Facebook Page', textLimit: 63_206, imageCaptionLimit: 63_206, maxImages: 10, acceptsVideo: true,
  connectionHelp: 'Connect a Facebook Page and grant pages_manage_posts.', configured: () => Boolean(metaConfiguration()),
  async publish(_workspace, channel, _nonce, content, image, images) {
    const token = await credentials('facebook', channel.id, channel.workspaceId);
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

/** Creates an Instagram media container and waits until Instagram has processed it. */
async function instagramContainer(igUserId: string, token: string, params: Record<string, string>): Promise<{ id: string } | PublishResult> {
  const created = await request(`${igUserId}/media`, token, new URLSearchParams(params));
  if (created.kind !== 'ok') return created.kind === 'uncertain' ? { kind: 'failed', error: 'Instagram did not confirm a media upload; nothing was published.' } : created;
  const container = z.object({ id: z.string().min(1) }).safeParse(created.json);
  if (!container.success) return { kind: 'failed', error: 'Instagram did not return a media container; nothing was published.' };
  for (let attempt = 0; attempt < 15; attempt++) {
    const status = await request(`${container.data.id}?fields=status_code`, token);
    if (status.kind !== 'ok') return status.kind === 'failed' ? status : {
      kind: 'failed', error: 'Instagram created the media but its readiness could not be confirmed; nothing was published.',
    };
    const value = z.object({ status_code: z.string() }).safeParse(status.json);
    if (value.success && value.data.status_code === 'FINISHED') return { id: container.data.id };
    if (value.success && value.data.status_code === 'ERROR') return { kind: 'failed', error: 'Instagram could not process one of the images.' };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { kind: 'failed', error: 'Instagram is still processing the images; nothing was published. Try again in a minute.' };
}

export const instagram: OAuthProviderAdapter = {
  kind: 'oauth', name: 'Instagram professional account', textLimit: 2_200, imageCaptionLimit: 2_200, requiresImage: true,
  // Up to 10 photos are published together as one carousel post (Instagram's limit).
  maxImages: 10,
  connectionHelp: 'Connect a professional Instagram account linked to a Facebook Page.', configured: () => Boolean(metaConfiguration()),
  async publish(_workspace, channel, _nonce, content, image, images) {
    const photos = (images ?? (image ? [image] : [])).filter((item) => item.type.startsWith('image/') && item.url).slice(0, 10);
    if (!photos.length) return { kind: 'failed', error: 'Instagram requires a publicly deliverable image.' };
    const token = await credentials('instagram', channel.id, channel.workspaceId);
    let creationId: string;
    if (photos.length > 1) {
      // Carousel: one container per photo, then a CAROUSEL container that holds them, then publish.
      const children: string[] = [];
      for (const photo of photos) {
        const child = await instagramContainer(channel.externalId, token, { image_url: photo.url!, is_carousel_item: 'true' });
        if (!('id' in child)) return child;
        children.push(child.id);
      }
      const carousel = await instagramContainer(channel.externalId, token, { media_type: 'CAROUSEL', children: children.join(','), caption: content });
      if (!('id' in carousel)) return carousel;
      creationId = carousel.id;
    } else {
      const single = await instagramContainer(channel.externalId, token, { image_url: photos[0]!.url!, caption: content });
      if (!('id' in single)) return single;
      creationId = single.id;
    }
    const result = await request(`${channel.externalId}/media_publish`, token, new URLSearchParams({ creation_id: creationId }));
    if (result.kind !== 'ok') return result;
    const parsed = z.object({ id: z.string().min(1) }).safeParse(result.json);
    if (!parsed.success) return { kind: 'uncertain', error: 'Instagram published without returning a media identifier.' };
    const details = await request(`${parsed.data.id}?fields=permalink`, token);
    const permalink = details.kind === 'ok'
      ? z.object({ permalink: z.url() }).safeParse(details.json).data?.permalink ?? null : null;
    return { kind: 'published', externalId: parsed.data.id, permalink };
  },
};

/** Used by the comments inbox (comments.ts). */
export { credentials as metaCredentials, request as metaRequest };
