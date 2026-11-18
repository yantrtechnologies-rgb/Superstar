import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './client';
import { type OAuthProviderAdapter, ProviderConfigurationError, retryAfter } from './provider-contract';
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
    scope: 'tweet.read tweet.write users.read offline.access', code_challenge_method: 'S256',
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
  kind: 'oauth', name: 'X account', textLimit: 280, imageCaptionLimit: null,
  connectionHelp: 'Connect an X account with OAuth 2.0 to publish text posts.', configured: xConfigured,
  async publish(_workspace, channel, _nonce, content, media) {
    if (media) return { kind: 'failed', error: 'This X connector currently supports text posts only.' };
    const authorization = await access(channel.id, channel.workspaceId);
    if (!authorization) return { kind: 'failed', error: 'Reconnect the X account.' };
    const response = await fetch('https://api.x.com/2/tweets', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: content }),
    }).catch(() => null);
    if (!response) return { kind: 'uncertain', error: 'X did not confirm the post. Check the account before retrying.' };
    if (response.status === 401 || response.status === 403) return { kind: 'failed', error: 'X denied publishing access. Reconnect the account.' };
    if (response.status === 429) return retryAfter(Number(response.headers.get('Retry-After')));
    const result = z.object({ data: z.object({ id: z.string() }) }).safeParse(await response.json().catch(() => ({})));
    if (!response.ok || !result.success) return { kind: 'failed', error: 'X rejected the post.' };
    return { kind: 'published', externalId: result.data.data.id, permalink: `https://x.com/i/web/status/${result.data.data.id}` };
  },
};
