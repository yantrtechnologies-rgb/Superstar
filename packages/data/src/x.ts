import { assertChannelCapacity } from './plans';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './client';
import { type OAuthProviderAdapter, ProviderConfigurationError, retryAfter, type PublishResult } from './provider-contract';
import { openToken, sealToken, vaultConfigured } from './token-vault';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

const provider = 'x';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const binding = (workspaceId: string, channelId: string) => `${provider}/${workspaceId}/${channelId}`;
function settings() {
  const { APP_URL, X_CLIENT_ID: clientId, X_CLIENT_SECRET: clientSecret } = process.env;
  if (!APP_URL || !clientId || !clientSecret || !vaultConfigured()) return null;
  try {
    const origin = new URL(APP_URL);
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) return null;
    return { clientId, clientSecret, callback: new URL('/api/connect/x', origin).href };
  } catch { return null; }
}
async function manager(tx: Prisma.TransactionClient, userId: string, workspaceId: string) {
  const member = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!member || !canManageTeam(member.role)) throw new WorkspaceAccessError('You cannot manage this connection.');
}
async function exchange(body: URLSearchParams) {
  const config = settings();
  if (!config) throw new ProviderConfigurationError('X OAuth requires operator configuration.');
  const response = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}` },
  }).catch(() => null);
  const value = await response?.json().catch(() => ({})) as Record<string, unknown> | undefined;
  if (!response?.ok || typeof value?.access_token !== 'string') throw new ProviderConfigurationError('X did not authorize this connection.');
  return {
    access: value.access_token, refresh: typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
    expiresAt: new Date(Date.now() + (typeof value.expires_in === 'number' ? value.expires_in : 7200) * 1000),
  };
}
export function xConfigured() { return Boolean(settings()); }
export async function beginXConnection(userId: string, slug: string) {
  const workspace = await prisma.workspace.findUnique({ where: { slug } });
  if (!workspace) throw new WorkspaceAccessError('Workspace unavailable.');
  await manager(prisma, userId, workspace.id);
  const config = settings();
  if (!config) throw new ProviderConfigurationError('X OAuth requires operator configuration.');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const hash = digest(state);
  await prisma.oAuthState.create({ data: {
    hash, provider, userId, workspaceId: workspace.id, expiresAt: new Date(Date.now() + 10 * 60_000),
    payload: sealToken(verifier, `x-state/${hash}`),
  } });
  const url = new URL('https://x.com/i/oauth2/authorize');
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: config.callback, state,
    scope: 'tweet.read tweet.write users.read media.write offline.access', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();
  return url.href;
}
export async function completeXConnection(userId: string, state: string, code?: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new ProviderConfigurationError('Invalid X connection request.');
  const hash = digest(state);
  const where = { hash, provider, userId, expiresAt: { gt: new Date() } };
  const grant = await prisma.oAuthState.findFirst({ where, include: { workspace: true } });
  if (!grant?.payload || !(await prisma.oAuthState.deleteMany({ where })).count) throw new ProviderConfigurationError('X connection expired.');
  await manager(prisma, userId, grant.workspaceId);
  if (!code) return { slug: grant.workspace.slug, connected: false };
  const config = settings();
  if (!config) throw new ProviderConfigurationError('X OAuth requires operator configuration.');
  const tokens = await exchange(new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: config.callback,
    code_verifier: openToken(grant.payload, `x-state/${hash}`), client_id: config.clientId,
  }));
  const response = await fetch('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${tokens.access}` } });
  const profile = z.object({ data: z.object({ id: z.string(), name: z.string(), username: z.string() }) })
    .safeParse(await response.json().catch(() => ({})));
  if (!response.ok || !profile.success) throw new ProviderConfigurationError('X did not return an authorized account.');
  await prisma.$transaction(async (tx) => {
    await manager(tx, userId, grant.workspaceId);
    const account = profile.data.data;
    await assertChannelCapacity(tx, grant.workspaceId, [{ provider, externalId: account.id }]);
    const channel = await tx.channel.upsert({
      where: { workspaceId_provider_externalId: { workspaceId: grant.workspaceId, provider, externalId: account.id } },
      create: { workspaceId: grant.workspaceId, provider, externalId: account.id, name: `@${account.username}` },
      update: { name: `@${account.username}` },
    });
    const base = binding(grant.workspaceId, channel.id);
    const values = {
      accessToken: sealToken(tokens.access, base + '/access'), accessExpiresAt: tokens.expiresAt,
      refreshToken: tokens.refresh ? sealToken(tokens.refresh, base + '/refresh') : null,
      refreshExpiresAt: null, revokedAt: null,
    };
    await tx.providerCredential.upsert({ where: { channelId: channel.id }, create: { channelId: channel.id, ...values }, update: values });
    await tx.auditEvent.create({ data: { workspaceId: grant.workspaceId, actorId: userId, subjectId: channel.id, action: 'channel.oauth_connected' } });
  });
  return { slug: grant.workspace.slug, connected: true };
}
async function access(channelId: string, workspaceId: string) {
  const current = await prisma.providerCredential.findFirst({ where: { channelId, channel: { workspaceId, provider } } });
  if (!current || current.revokedAt) return null;
  const base = binding(workspaceId, channelId);
  if (current.accessExpiresAt > new Date(Date.now() + 60_000)) return openToken(current.accessToken, base + '/access');
  if (!current.refreshToken) return null;
  const config = settings();
  if (!config) return null;
  const tokens = await exchange(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: openToken(current.refreshToken, base + '/refresh'), client_id: config.clientId,
  }));
  await prisma.providerCredential.update({ where: { channelId }, data: {
    accessToken: sealToken(tokens.access, base + '/access'), accessExpiresAt: tokens.expiresAt,
    refreshToken: tokens.refresh ? sealToken(tokens.refresh, base + '/refresh') : current.refreshToken,
  } });
  return tokens.access;
}
export async function disconnectX(userId: string, slug: string, channelId: string) {
  await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findFirst({ where: { id: channelId, provider, workspace: { slug } } });
    if (!channel) throw new WorkspaceAccessError('Connection unavailable.');
    await manager(tx, userId, channel.workspaceId);
    await tx.providerCredential.deleteMany({ where: { channelId } });
    await tx.auditEvent.create({ data: { workspaceId: channel.workspaceId, actorId: userId, subjectId: channel.id, action: 'channel.oauth_disconnected' } });
  });
}
export const x: OAuthProviderAdapter = {
  // Normal X accounts get 280 characters; X Premium accounts up to 25,000. Longer text is tried whole, then threaded.
  kind: 'oauth', name: 'X account', textLimit: 280, imageCaptionLimit: 280,
  // X allows up to 4 photos per post.
  maxImages: 4,
  splitsLongText: true,
  connectionHelp: 'Connect an X account with OAuth 2.0 to publish text and photo posts.', configured: xConfigured,
  async publish(_workspace, channel, _nonce, content, image, images) {
    const photos = (images ?? (image ? [image] : [])).filter((item) => item.type.startsWith('image/')).slice(0, 4);
    let media: { media_ids: string[] } | undefined;
    if (photos.length) {
      const uploaded = await uploadPhotos(channel, photos);
      if (!Array.isArray(uploaded)) return uploaded;
      media = { media_ids: uploaded };
    }
    const text = content.trim();
    if (xLength(text) > 280) {
      // Accounts with X Premium may post up to 25,000 characters in one post; X refuses it for everyone else.
      const whole = await postTweet(channel, { text, ...(media && { media }) }, { lengthFallback: true });
      if (whole !== 'too-long') return whole;
    }
    const [first, ...rest] = splitForX(text);
    const opening = await postTweet(channel, { text: first, ...(media && { media }) });
    if (opening.kind !== 'published' || !rest.length) return opening;
    // The rest of a long post follows as replies, so readers see one numbered thread.
    let parent = opening.externalId;
    for (const part of rest) {
      const next = await postTweet(channel, { text: part, reply: { in_reply_to_tweet_id: parent } });
      if (next.kind !== 'published') break; // The opening post is live; the thread just ends early.
      parent = next.externalId;
    }
    return opening;
  },
  reply: (_workspace, channel, _nonce, content, parentId) => postTweet(channel, { text: content, reply: { in_reply_to_tweet_id: parentId } }),
};

/** X's character weighting: most Latin text counts 1, emoji and CJK count 2, every link counts 23. */
function xLength(text: string) {
  let total = 0;
  for (const piece of text.split(/(https?:\/\/\S+)/)) {
    if (/^https?:\/\//.test(piece)) { total += 23; continue; }
    for (const char of piece) {
      const code = char.codePointAt(0)!;
      total += code <= 4351 || (code >= 8192 && code <= 8205) || (code >= 8208 && code <= 8223) || (code >= 8242 && code <= 8247) ? 1 : 2;
    }
  }
  return total;
}

/** Splits text into posts of at most 280 weighted characters, breaking between words and numbering each part. */
export function splitForX(content: string, limit = 280): string[] {
  const text = content.trim();
  if (xLength(text) <= limit) return [text];
  const budget = limit - 8; // room for " (10/12)"
  const words = text.match(/\S+\s*/g) ?? [];
  const parts: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && xLength((current + word).trimEnd()) > budget) { parts.push(current.trimEnd()); current = ''; }
    let piece = word;
    while (xLength(piece.trimEnd()) > budget) { // a single very long word
      let cut = budget;
      while (xLength(piece.slice(0, cut)) > budget) cut--;
      parts.push(piece.slice(0, cut)); piece = piece.slice(cut);
    }
    current += piece;
  }
  if (current.trim()) parts.push(current.trimEnd());
  return parts.map((part, index) => `${part} (${index + 1}/${parts.length})`);
}

async function uploadPhotos(channel: { id: string; workspaceId: string }, photos: { bytes: Uint8Array<ArrayBuffer>; type: string }[]): Promise<string[] | PublishResult> {
    const authorization = await access(channel.id, channel.workspaceId);
    if (!authorization) return { kind: 'failed', error: 'Reconnect the X account.' };
    const mediaIds: string[] = [];
    for (const [index, photo] of photos.entries()) {
      const form = new FormData();
      form.set('media', new Blob([photo.bytes], { type: photo.type }), `image-${index}.${photo.type === 'image/png' ? 'png' : 'jpg'}`);
      form.set('media_category', 'tweet_image');
      const response = await fetch('https://api.x.com/2/media/upload', {
        method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${authorization}` },
      }).catch(() => null);
      if (!response) return { kind: 'failed', error: 'X did not confirm a photo upload; nothing was posted.' };
      if (response.status === 401 || response.status === 403) {
        return { kind: 'failed', error: 'X refused the photo upload. Reconnect the X account on the Channels page so it can upload photos, then try again.' };
      }
      if (response.status === 402) return { kind: 'failed', error: creditsMessage };
      if (response.status === 429) return retryAfter(Number(response.headers.get('Retry-After')));
      const json = await response.json().catch(() => ({}));
      const uploaded = z.object({ data: z.object({ id: z.string().min(1) }) }).safeParse(json);
      const legacy = z.object({ media_id_string: z.string().min(1) }).safeParse(json);
      const id = uploaded.data?.data.id ?? legacy.data?.media_id_string;
      if (!response.ok || !id) return { kind: 'failed', error: 'X rejected one of the photos; nothing was posted.' };
      mediaIds.push(id);
    }
    return mediaIds;
}

const creditsMessage = 'X refused the post because the X developer account has no API credit. Add credit at console.x.com (Billing), then post again.';

type XChannel = { id: string; workspaceId: string };
async function postTweet(channel: XChannel, body: Record<string, unknown>): Promise<PublishResult>;
async function postTweet(channel: XChannel, body: Record<string, unknown>, options: { lengthFallback: true }): Promise<PublishResult | 'too-long'>;
async function postTweet(channel: XChannel, body: Record<string, unknown>, options?: { lengthFallback: true }): Promise<PublishResult | 'too-long'> {
    const authorization = await access(channel.id, channel.workspaceId);
    if (!authorization) return { kind: 'failed', error: 'Reconnect the X account.' };
    const response = await fetch('https://api.x.com/2/tweets', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    if (!response) return { kind: 'uncertain', error: 'X did not confirm the post. Check the account before retrying.' };
    // X refuses long text from accounts without Premium (400 or 403); the caller then posts a thread instead.
    if (options?.lengthFallback && (response.status === 400 || response.status === 403)) return 'too-long';
    if (response.status === 401 || response.status === 403) return { kind: 'failed', error: 'X denied publishing access. Reconnect the account.' };
    if (response.status === 402) return { kind: 'failed', error: creditsMessage };
    if (response.status === 429) return retryAfter(Number(response.headers.get('Retry-After')));
    const result = z.object({ data: z.object({ id: z.string() }) }).safeParse(await response.json().catch(() => ({})));
    if (!response.ok || !result.success) return { kind: 'failed', error: 'X rejected the post.' };
    return { kind: 'published', externalId: result.data.data.id, permalink: `https://x.com/i/web/status/${result.data.data.id}` };
}
