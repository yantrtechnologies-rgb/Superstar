// Instagram professional accounts connected with Instagram Login ("Instagram API with Instagram Login"), so they need no
// linked Facebook Page. Uses the Instagram app ID and secret from the Meta app's Instagram product, and publishes through
// graph.instagram.com with the same container flow as the Page-linked connection (instagram-publish.ts).
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './client';
import { type InstagramCall, publishInstagramMedia } from './instagram-publish';
import { assertChannelCapacity } from './plans';
import { type OAuthProviderAdapter, ProviderConfigurationError } from './provider-contract';
import { openToken, sealToken, vaultConfigured } from './token-vault';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

const provider = 'instagram-direct';
const scopes = ['instagram_business_basic', 'instagram_business_content_publish'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const binding = (workspaceId: string, channelId: string) => `${provider}/${workspaceId}/${channelId}`;

function settings() {
  const { APP_URL, INSTAGRAM_APP_ID: appId, INSTAGRAM_APP_SECRET: secret } = process.env;
  if (!APP_URL || !appId || !secret || !/^\d{5,25}$/.test(appId) || !vaultConfigured()) return null;
  try {
    const origin = new URL(APP_URL);
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) return null;
    const version = /^v\d+\.\d+$/.test(process.env.META_GRAPH_VERSION ?? '') ? process.env.META_GRAPH_VERSION! : 'v23.0';
    return { appId, secret, version, callback: new URL('/api/connect/instagram-direct', origin).href };
  } catch { return null; }
}

export function instagramDirectConfigured() { return Boolean(settings()); }

async function manager(tx: Prisma.TransactionClient, userId: string, workspaceId: string) {
  const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot manage this connection.');
}

async function getJson(url: URL | string, init?: RequestInit) {
  const response = await fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!response) return null;
  return { ok: response.ok, status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
}

export async function beginInstagramDirectConnection(userId: string, slug: string, connectLinkHash?: string) {
  const workspace = await prisma.workspace.findUnique({ where: { slug } });
  if (!workspace) throw new WorkspaceAccessError('Workspace unavailable.');
  await manager(prisma, userId, workspace.id);
  const config = settings();
  if (!config) throw new ProviderConfigurationError('Instagram Login requires operator configuration.');
  const state = randomBytes(32).toString('base64url');
  await prisma.oAuthState.create({ data: {
    hash: digest(state), provider, userId, workspaceId: workspace.id, expiresAt: new Date(Date.now() + 10 * 60_000),
    connectLinkHash: connectLinkHash ?? null,
  } });
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: config.appId, redirect_uri: config.callback, response_type: 'code', scope: scopes.join(','), state,
    // Always ask for the Instagram login, so nobody connects the browser's signed-in account by accident.
    force_reauth: 'true', enable_fb_login: '0',
  }).toString();
  return url.href;
}

type Outcome = { slug: string; connected: boolean; reason: 'saved' | 'instagram-unavailable' | 'instagram-not-professional' };

export async function completeInstagramDirectConnection(userId: string, state: string, code?: string): Promise<Outcome> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new ProviderConfigurationError('Invalid Instagram connection request.');
  const where = { hash: digest(state), provider, userId, expiresAt: { gt: new Date() } };
  const grant = await prisma.oAuthState.findFirst({ where, include: { workspace: true } });
  if (!grant || !(await prisma.oAuthState.deleteMany({ where })).count) throw new ProviderConfigurationError('Instagram connection expired.');
  await manager(prisma, userId, grant.workspaceId);
  const slug = grant.workspace.slug;
  const config = settings();
  if (!config) throw new ProviderConfigurationError('Instagram Login requires operator configuration.');
  if (!code) return { slug, connected: false, reason: 'instagram-unavailable' };

  // Instagram may append "#_" to the code in the redirect.
  const exchanged = await getJson('https://api.instagram.com/oauth/access_token', {
    method: 'POST', body: new URLSearchParams({
      client_id: config.appId, client_secret: config.secret, grant_type: 'authorization_code',
      redirect_uri: config.callback, code: code.replace(/#_$/, ''),
    }),
  });
  // The response is either { access_token, user_id, permissions } or { data: [ that ] }.
  const body = exchanged?.json;
  const first: unknown = body && Array.isArray(body.data) ? (body.data as unknown[])[0] : body;
  const shortLived = z.object({ access_token: z.string().min(1), permissions: z.union([z.string(), z.array(z.string())]).optional() })
    .safeParse(first);
  if (!exchanged?.ok || !shortLived.success) {
    console.error(JSON.stringify({ event: 'instagram_direct.token_failed', status: exchanged?.status, error: exchanged?.json.error_type, message: exchanged?.json.error_message }));
    return { slug, connected: false, reason: 'instagram-unavailable' };
  }
  const granted = shortLived.data.permissions;
  const grantedList = Array.isArray(granted) ? granted : granted?.split(',') ?? scopes;
  if (!scopes.every((scope) => grantedList.includes(scope))) return { slug, connected: false, reason: 'instagram-unavailable' };

  const longUrl = new URL('https://graph.instagram.com/access_token');
  longUrl.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: config.secret, access_token: shortLived.data.access_token }).toString();
  const long = await getJson(longUrl);
  const longLived = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).safeParse(long?.json);
  if (!long?.ok || !longLived.success) return { slug, connected: false, reason: 'instagram-unavailable' };
  const token = longLived.data.access_token;

  const meUrl = new URL(`https://graph.instagram.com/${config.version}/me`);
  meUrl.search = new URLSearchParams({ fields: 'user_id,username,account_type', access_token: token }).toString();
  const me = await getJson(meUrl);
  const profile = z.object({ user_id: z.union([z.string(), z.number()]).transform(String), username: z.string().min(1), account_type: z.string().optional() })
    .safeParse(me?.json);
  if (!me?.ok || !profile.success) return { slug, connected: false, reason: 'instagram-unavailable' };
  if (profile.data.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(profile.data.account_type)) {
    return { slug, connected: false, reason: 'instagram-not-professional' };
  }
  const externalId = profile.data.user_id;
  const name = '@' + profile.data.username;
  await prisma.$transaction(async (tx) => {
    await manager(tx, userId, grant.workspaceId);
    await assertChannelCapacity(tx, grant.workspaceId, [{ provider, externalId }]);
    const channel = await tx.channel.upsert({
      where: { workspaceId_provider_externalId: { workspaceId: grant.workspaceId, provider, externalId } },
      create: { workspaceId: grant.workspaceId, provider, externalId, name }, update: { name },
    });
    const values = {
      accessToken: sealToken(token, binding(grant.workspaceId, channel.id) + '/access'),
      accessExpiresAt: new Date(Date.now() + longLived.data.expires_in * 1000), refreshToken: null, refreshExpiresAt: null, revokedAt: null,
    };
    await tx.providerCredential.upsert({ where: { channelId: channel.id }, create: { channelId: channel.id, ...values }, update: values });
    await tx.auditEvent.create({ data: { workspaceId: grant.workspaceId, actorId: userId, subjectId: channel.id, action: 'channel.oauth_connected' } });
  });
  return { slug, connected: true, reason: 'saved' };
}

/** The account's long-lived token (60 days), refreshed when it has under 10 days left. */
async function access(channelId: string, workspaceId: string) {
  const current = await prisma.providerCredential.findFirst({ where: { channelId, channel: { workspaceId, provider } } });
  if (!current || current.revokedAt || current.accessExpiresAt <= new Date()) return null;
  const base = binding(workspaceId, channelId) + '/access';
  const token = openToken(current.accessToken, base);
  if (current.accessExpiresAt.getTime() - Date.now() > 10 * 86_400_000) return token;
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token }).toString();
  const refreshed = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).safeParse((await getJson(url))?.json);
  if (!refreshed.success) return token; // Still valid for now; the next post tries again.
  await prisma.providerCredential.update({ where: { channelId }, data: {
    accessToken: sealToken(refreshed.data.access_token, base), accessExpiresAt: new Date(Date.now() + refreshed.data.expires_in * 1000),
  } });
  return refreshed.data.access_token;
}

function caller(token: string, version: string): InstagramCall {
  return async (path, body) => {
    const url = new URL(`https://graph.instagram.com/${version}/${path}`);
    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? 'POST' : 'GET', body, headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { kind: 'uncertain', error: 'Instagram did not confirm whether the request completed. Check the account before retrying.' };
    }
    const json: unknown = await response.json().catch(() => ({}));
    if (response.ok) return { kind: 'ok', json };
    const error = z.object({ error: z.object({ message: z.string().optional(), code: z.number().optional(), is_transient: z.boolean().optional() }) })
      .safeParse(json).data?.error;
    if (error?.code === 190 || error?.code === 10 || error?.code === 200) {
      return { kind: 'failed', error: 'Instagram denied publishing access. Reconnect the account.' };
    }
    if (error?.is_transient || [1, 2, 4, 17, 32, 613].includes(error?.code ?? 0)) return { kind: 'retry', delayMs: 60_000 };
    return { kind: 'failed', error: error?.message ? `Instagram rejected the post: ${error.message}` : 'Instagram rejected the post.' };
  };
}

export async function disconnectInstagramDirect(userId: string, slug: string, channelId: string) {
  await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findFirst({ where: { id: channelId, provider, workspace: { slug } } });
    if (!channel) throw new WorkspaceAccessError('Connection unavailable.');
    await manager(tx, userId, channel.workspaceId);
    await tx.providerCredential.deleteMany({ where: { channelId } });
    await tx.auditEvent.create({ data: { workspaceId: channel.workspaceId, actorId: userId, subjectId: channel.id, action: 'channel.oauth_disconnected' } });
  });
}

export const instagramDirect: OAuthProviderAdapter = {
  kind: 'oauth', name: 'Instagram (no Facebook Page)', textLimit: 2_200, imageCaptionLimit: 2_200,
  requiresImage: true, acceptsVideo: true, maxImages: 10, formats: ['story'], configured: instagramDirectConfigured,
  connectionHelp: 'Sign in with Instagram to connect a Business or Creator account directly, with no Facebook Page needed. Posts photos, carousels and Reels.',
  async publish(_workspace, channel, _nonce, content, image, images, options) {
    const config = settings();
    if (!config) return { kind: 'failed', error: 'Instagram Login is not configured on this server.' };
    const token = await access(channel.id, channel.workspaceId);
    if (!token) return { kind: 'failed', error: 'The Instagram authorization expired. Reconnect the account.' };
    return publishInstagramMedia(caller(token, config.version), channel.externalId, content, images ?? (image ? [image] : []), options?.format);
  },
};
