import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishInstagramMedia } from '../packages/data/src/instagram-publish.ts';

/** A fake Graph API: records calls, finishes every container at once, and publishes as media 900. */
function graph() {
  const calls = [];
  let next = 100;
  const call = async (path, body) => {
    calls.push({ path, body: body ? Object.fromEntries(body) : undefined });
    if (path.endsWith('/media')) return { kind: 'ok', json: { id: String(next++) } };
    if (path.endsWith('?fields=status_code')) return { kind: 'ok', json: { status_code: 'FINISHED' } };
    if (path.endsWith('/media_publish')) return { kind: 'ok', json: { id: '900' } };
    if (path === '900?fields=permalink') return { kind: 'ok', json: { permalink: 'https://www.instagram.com/p/fixture/' } };
    throw new Error('unexpected ' + path);
  };
  return { calls, call };
}
const media = (type, url) => ({ bytes: new Uint8Array(0), type, url });

test('a single MP4 is published to Instagram as a Reel that also shows in the feed', async () => {
  const { calls, call } = graph();
  const result = await publishInstagramMedia(call, '1784', 'Reel caption', [media('video/mp4', 'https://cdn.example/v.mp4')]);
  assert.deepEqual(result, { kind: 'published', externalId: '900', permalink: 'https://www.instagram.com/p/fixture/' });
  assert.deepEqual(calls[0], { path: '1784/media', body: { media_type: 'REELS', video_url: 'https://cdn.example/v.mp4', caption: 'Reel caption', share_to_feed: 'true' } });
  assert.deepEqual(calls.find(({ path }) => path.endsWith('/media_publish')).body, { creation_id: '100' });
});

test('photos and videos together become one carousel', async () => {
  const { calls, call } = graph();
  await publishInstagramMedia(call, '1784', 'Carousel caption', [media('image/jpeg', 'https://cdn.example/a.jpg'), media('video/mp4', 'https://cdn.example/b.mp4')]);
  const created = calls.filter(({ path }) => path === '1784/media').map(({ body }) => body);
  assert.deepEqual(created, [
    { image_url: 'https://cdn.example/a.jpg', is_carousel_item: 'true' },
    { media_type: 'VIDEO', video_url: 'https://cdn.example/b.mp4', is_carousel_item: 'true' },
    { media_type: 'CAROUSEL', children: '100,101', caption: 'Carousel caption' },
  ]);
});

test('Instagram refuses a post with no deliverable media without calling the API', async () => {
  const { calls, call } = graph();
  const result = await publishInstagramMedia(call, '1784', 'Text only', [media('image/jpeg', undefined)]);
  assert.equal(result.kind, 'failed');
  assert.equal(calls.length, 0);
});

test('a Story is one photo or video with no caption', async () => {
  const { calls, call } = graph();
  await publishInstagramMedia(call, '1784', 'Ignored caption', [media('video/mp4', 'https://cdn.example/s.mp4'), media('image/jpeg', 'https://cdn.example/x.jpg')], 'story');
  const created = calls.filter(({ path }) => path === '1784/media').map(({ body }) => body);
  assert.deepEqual(created, [{ media_type: 'STORIES', video_url: 'https://cdn.example/s.mp4' }]);
});