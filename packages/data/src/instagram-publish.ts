import { z } from 'zod';
import type { PublishingImage, PublishResult } from './provider-contract';

/** One Graph API call: GET when there is no body. Both Instagram connections (via a Facebook Page, or Instagram Login) use it. */
export type InstagramCall = (path: string, body?: URLSearchParams) => Promise<
  { kind: 'ok'; json: unknown } | { kind: 'failed' | 'uncertain'; error: string } | { kind: 'retry'; delayMs: number }
>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a media container and waits until Instagram has processed it (videos take longer than photos). */
async function container(call: InstagramCall, igUserId: string, params: Record<string, string>, video: boolean): Promise<{ id: string } | PublishResult> {
  const created = await call(`${igUserId}/media`, new URLSearchParams(params));
  if (created.kind !== 'ok') return created.kind === 'uncertain' ? { kind: 'failed', error: 'Instagram did not confirm a media upload; nothing was published.' } : created;
  const parsed = z.object({ id: z.string().min(1) }).safeParse(created.json);
  if (!parsed.success) return { kind: 'failed', error: 'Instagram did not return a media container; nothing was published.' };
  const attempts = video ? 60 : 15;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const status = await call(`${parsed.data.id}?fields=status_code`);
    if (status.kind !== 'ok') return status.kind === 'failed' ? status : {
      kind: 'failed', error: 'Instagram created the media but its readiness could not be confirmed; nothing was published.',
    };
    const value = z.object({ status_code: z.string() }).safeParse(status.json);
    if (value.success && value.data.status_code === 'FINISHED') return { id: parsed.data.id };
    if (value.success && value.data.status_code === 'ERROR') {
      return { kind: 'failed', error: video ? 'Instagram could not process the video. Reels need an MP4 (H.264, AAC) between 3 seconds and 15 minutes.' : 'Instagram could not process one of the images.' };
    }
    await sleep(video ? 3_000 : 1_000);
  }
  return { kind: 'failed', error: `Instagram is still processing the ${video ? 'video' : 'images'}; nothing was published. Try again in a few minutes.` };
}

/**
 * Publishes a photo, a carousel (up to 10 photos and videos) or a Reel (one video). Media reach Instagram as
 * short-lived signed URLs, because Instagram downloads them itself.
 */
export async function publishInstagramMedia(call: InstagramCall, igUserId: string, content: string, media: PublishingImage[]): Promise<PublishResult> {
  const items = media.filter((item) => item.url && (item.type.startsWith('image/') || item.type === 'video/mp4')).slice(0, 10);
  if (!items.length) return { kind: 'failed', error: 'Instagram requires a publicly deliverable image or video.' };
  let creationId: string;
  if (items.length > 1) {
    const children: string[] = [];
    for (const item of items) {
      const video = item.type === 'video/mp4';
      const child = await container(call, igUserId, video
        ? { media_type: 'VIDEO', video_url: item.url!, is_carousel_item: 'true' }
        : { image_url: item.url!, is_carousel_item: 'true' }, video);
      if (!('id' in child)) return child;
      children.push(child.id);
    }
    const carousel = await container(call, igUserId, { media_type: 'CAROUSEL', children: children.join(','), caption: content }, false);
    if (!('id' in carousel)) return carousel;
    creationId = carousel.id;
  } else {
    const [item] = items as [PublishingImage];
    const video = item.type === 'video/mp4';
    // A single video is published as a Reel (Instagram no longer has plain feed videos) and also shows in the feed.
    const single = await container(call, igUserId, video
      ? { media_type: 'REELS', video_url: item.url!, caption: content, share_to_feed: 'true' }
      : { image_url: item.url!, caption: content }, video);
    if (!('id' in single)) return single;
    creationId = single.id;
  }
  const result = await call(`${igUserId}/media_publish`, new URLSearchParams({ creation_id: creationId }));
  if (result.kind !== 'ok') return result;
  const parsed = z.object({ id: z.string().min(1) }).safeParse(result.json);
  if (!parsed.success) return { kind: 'uncertain', error: 'Instagram published without returning a media identifier.' };
  const details = await call(`${parsed.data.id}?fields=permalink`);
  const permalink = details.kind === 'ok' ? z.object({ permalink: z.url() }).safeParse(details.json).data?.permalink ?? null : null;
  return { kind: 'published', externalId: parsed.data.id, permalink };
}
