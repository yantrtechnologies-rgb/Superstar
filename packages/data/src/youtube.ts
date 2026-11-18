import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './client';
import { type OAuthProviderAdapter, ProviderConfigurationError, retryAfter } from './provider-contract';
import { openToken, sealToken, vaultConfigured } from './token-vault';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

const provider = 'youtube';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const binding = (workspaceId: string, channelId: string) => `${provider}/${workspaceId}/${channelId}`;

function settings() {
  const { APP_URL, YOUTUBE_CLIENT_ID: clientId, YOUTUBE_CLIENT_SECRET: clientSecret } = process.env;
  if (!APP_URL || !clientId || !clientSecret || !vaultConfigured()) return null;
  try {
    const origin = new URL(APP_URL);
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) return null;
    return { clientId, clientSecret, callback: new URL('/api/connect/youtube', origin).href };
  } catch { return null; }
}

async function manager(tx: Prisma.TransactionClient, userId: string, workspaceId: string) {
  const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot manage this connection.');
}

async function token(body: URLSearchParams) {
  const config = settings();
  if (!config) throw new ProviderConfigurationError('YouTube OAuth requires operator configuration.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response) throw new ProviderConfigurationError('YouTube authorization is temporarily unavailable.');
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof value.access_token !== 'string' || typeof value.expires_in !== 'number') {
    throw new ProviderConfigurationError('YouTube did not authorize this connection.');
  }
  return {
    access: value.access_token, expiresAt: new Date(Date.now() + value.expires_in * 1000),
    refresh: typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
  };
}

export function youtubeConfigured() { return Boolean(settings()); }

export async function beginYouTubeConnection(userId: string, slug: string) {
  const workspace = await prisma.workspace.findUnique({ where: { slug } });
  if (!workspace) throw new WorkspaceAccessError('Workspace unavailable.');
  await manager(prisma, userId, workspace.id);
  const config = settings();
  if (!config) throw new ProviderConfigurationError('YouTube OAuth requires operator configuration.');
  const state = randomBytes(32).toString('base64url');
  await prisma.oAuthState.create({ data: {
    hash: digest(state), provider, userId, workspaceId: workspace.id, expiresAt: new Date(Date.now() + 10 * 60_000),
  } });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.callback, response_type: 'code', state,
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  }).toString();
  return url.href;
}

export async function completeYouTubeConnection(userId: string, state: string, code?: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new ProviderConfigurationError('Invalid YouTube connection request.');
  const where = { hash: digest(state), provider, userId, expiresAt: { gt: new Date() } };
  const grant = await prisma.oAuthState.findFirst({ where, include: { workspace: true } });
  if (!grant || !(await prisma.oAuthState.deleteMany({ where })).count) throw new ProviderConfigurationError('YouTube connection expired.');
  await manager(prisma, userId, grant.workspaceId);
  if (!code) return { slug: grant.workspace.slug, connected: false };
  const config = settings();
  if (!config) throw new ProviderConfigurationError('YouTube OAuth requires operator configuration.');
  const tokens = await token(new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret, code,
    grant_type: 'authorization_code', redirect_uri: config.callback,
  }));
  const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true', {
    headers: { Authorization: `Bearer ${tokens.access}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  const profile = z.object({ items: z.array(z.object({ id: z.string(), snippet: z.object({ title: z.string() }) })).min(1) })
    .safeParse(await response.json().catch(() => ({})));
  if (!response.ok || !profile.success) throw new ProviderConfigurationError('YouTube did not return an authorized channel.');
  const account = profile.data.items[0]!;
  await prisma.$transaction(async (tx) => {
    await manager(tx, userId, grant.workspaceId);
    const channel = await tx.channel.upsert({
      where: { workspaceId_provider_externalId: { workspaceId: grant.workspaceId, provider, externalId: account.id } },
      create: { workspaceId: grant.workspaceId, provider, externalId: account.id, name: account.snippet.title },
      update: { name: account.snippet.title },
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
  const refreshed = await token(new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token',
    refresh_token: openToken(current.refreshToken, base + '/refresh'),
  }));
  await prisma.providerCredential.update({ where: { channelId }, data: {
    accessToken: sealToken(refreshed.access, base + '/access'), accessExpiresAt: refreshed.expiresAt,
  } });
  return refreshed.access;
}

export async function disconnectYouTube(userId: string, slug: string, channelId: string) {
  await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findFirst({ where: { id: channelId, provider, workspace: { slug } } });
    if (!channel) throw new WorkspaceAccessError('Connection unavailable.');
    await manager(tx, userId, channel.workspaceId);
    await tx.providerCredential.deleteMany({ where: { channelId } });
    await tx.auditEvent.create({ data: { workspaceId: channel.workspaceId, actorId: userId, subjectId: channel.id, action: 'channel.oauth_disconnected' } });
  });
}

export const youtube: OAuthProviderAdapter = {
  kind: 'oauth', name: 'YouTube channel', textLimit: 5000, imageCaptionLimit: 5000,
  requiresVideo: true, acceptsVideo: true, configured: youtubeConfigured,
  connectionHelp: 'Connect a YouTube channel to upload MP4 videos. Uploads default to private unless the operator changes the configured privacy status.',
  async publish(_workspace, channel, _nonce, content, media) {
    if (!media || media.type !== 'video/mp4') return { kind: 'failed', error: 'YouTube requires an MP4 video.' };
    const authorization = await access(channel.id, channel.workspaceId);
    if (!authorization) return { kind: 'failed', error: 'Reconnect the YouTube channel.' };
    const [first = 'Untitled video', ...rest] = content.split('\n');
    const privacy = z.enum(['private', 'unlisted', 'public']).catch('private').parse(process.env.YOUTUBE_DEFAULT_PRIVACY_STATUS);
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(media.bytes.byteLength),
      },
      body: JSON.stringify({ snippet: { title: first.slice(0, 100), description: rest.join('\n').slice(0, 5000) }, status: { privacyStatus: privacy } }),
    }).catch(() => null);
    if (!init) return { kind: 'uncertain', error: 'YouTube upload initialization was not confirmed.' };
    if (init.status === 401 || init.status === 403) return { kind: 'failed', error: 'YouTube denied upload access. Reconnect the channel.' };
    if (init.status === 429) return retryAfter(Number(init.headers.get('Retry-After')));
    const location = init.headers.get('location');
    if (!init.ok || !location) return { kind: 'failed', error: 'YouTube rejected the video metadata.' };
    const uploaded = await fetch(location, {
      method: 'PUT', body: media.bytes, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(media.bytes.byteLength) },
    }).catch(() => null);
    if (!uploaded) return { kind: 'uncertain', error: 'YouTube did not confirm the completed upload. Check Studio before retrying.' };
    if (uploaded.status === 429 || uploaded.status >= 500) return { kind: 'uncertain', error: 'YouTube may still be processing the upload. Check Studio before retrying.' };
    const result = z.object({ id: z.string().min(1) }).safeParse(await uploaded.json().catch(() => ({})));
    if (!uploaded.ok || !result.success) return { kind: 'failed', error: 'YouTube rejected the video upload.' };
    return { kind: 'published', externalId: result.data.id, permalink: `https://www.youtube.com/watch?v=${result.data.id}` };
  },
};
