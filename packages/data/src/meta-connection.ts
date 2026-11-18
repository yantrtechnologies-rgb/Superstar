import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './client';
import { ProviderConfigurationError } from './provider-contract';
import { openToken, sealToken, vaultConfigured } from './token-vault';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

export const metaProvider = z.enum(['facebook', 'instagram']);
type MetaProvider = z.infer<typeof metaProvider>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identifier = z.string().regex(/^[0-9]+$/);
const accountSchema = z.object({
  id: identifier, name: z.string().min(1), pageId: identifier, token: z.string().min(1),
});
const selectionSchema = z.object({
  provider: metaProvider, expiresAt: z.iso.datetime(), accounts: z.array(accountSchema).max(1000),
});

export function metaConfiguration() {
  const { META_APP_ID: appId, META_APP_SECRET: secret, APP_URL: origin } = process.env;
  const version = process.env.META_GRAPH_VERSION || 'v27.0';
  if (!appId || !/^[0-9]+$/.test(appId) || !secret || !origin || !vaultConfigured() || !/^v\d+\.0$/.test(version)) return null;
  try {
    const url = new URL(origin);
    if (url.username || url.password || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return null;
    return { appId, secret, version, callback: new URL('/api/connect/meta', url.origin).href };
  } catch { return null; }
}

async function manager(tx: Prisma.TransactionClient, userId: string, workspaceId: string) {
  const member = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!member || !canManageTeam(member.role)) throw new WorkspaceAccessError('You cannot manage these channels.');
}

async function graph(path: string, params: Record<string, string>, token?: string) {
  const config = metaConfiguration();
  if (!config) throw new ProviderConfigurationError('Meta connection setup is incomplete.');
  const url = new URL('https://graph.facebook.com/' + config.version + '/' + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (token) url.searchParams.set('appsecret_proof', createHmac('sha256', config.secret).update(token).digest('hex'));
  try {
    const response = await fetch(url, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Meta rejected the request');
    return await response.json() as unknown;
  } catch {
    throw new ProviderConfigurationError('Meta could not authorize this connection. Try again and grant the requested access.');
  }
}

export async function beginMetaConnection(userId: string, slug: string, provider: MetaProvider) {
  const workspace = await prisma.workspace.findUnique({ where: { slug } });
  if (!workspace) throw new WorkspaceAccessError('Workspace unavailable.');
  await manager(prisma, userId, workspace.id);
  const config = metaConfiguration();
  if (!config) throw new ProviderConfigurationError('Meta connection setup is incomplete.');
  const state = randomBytes(32).toString('base64url');
  const url = new URL('https://www.facebook.com/' + config.version + '/dialog/oauth');
  const scopes = ['pages_show_list', 'pages_read_engagement'];
  if (provider === 'facebook') scopes.push('pages_manage_posts');
  else scopes.push('instagram_basic', 'instagram_content_publish');
  url.search = new URLSearchParams({
    client_id: config.appId, redirect_uri: config.callback, state, response_type: 'code',
    scope: scopes.join(','), auth_type: 'rerequest',
  }).toString();
  await prisma.$transaction([
    prisma.oAuthState.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } }),
    prisma.oAuthState.create({ data: {
      hash: digest(state), userId, workspaceId: workspace.id, provider: 'meta-' + provider,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    } }),
  ]);
  return url.href;
}

export async function completeMetaConnection(userId: string, state: string, code?: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new ProviderConfigurationError('Invalid connection request.');
  const where = { hash: digest(state), userId, provider: { in: ['meta-facebook', 'meta-instagram'] }, expiresAt: { gt: new Date() } };
  const grant = await prisma.oAuthState.findFirst({ where, include: { workspace: true } });
  if (!grant || !(await prisma.oAuthState.deleteMany({ where })).count) throw new ProviderConfigurationError('Connection request expired.');
  await manager(prisma, userId, grant.workspaceId);
  const base = '/app/' + grant.workspace.slug + '/channels';
  if (!code) return base + '?status=meta-canceled';
  try {
    const config = metaConfiguration();
    if (!config) throw new ProviderConfigurationError('Meta configuration unavailable.');
    const provider = metaProvider.parse(grant.provider.slice(5));
    const tokens = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
    const short = tokens.parse(await graph('oauth/access_token', {
      client_id: config.appId, client_secret: config.secret, redirect_uri: config.callback, code,
    }));
    const long = tokens.parse(await graph('oauth/access_token', {
      grant_type: 'fb_exchange_token', client_id: config.appId, client_secret: config.secret,
      fb_exchange_token: short.access_token,
    }));
    const permissions = z.object({ data: z.array(z.object({ permission: z.string(), status: z.string() })) })
      .parse(await graph('me/permissions', {}, long.access_token));
    const required = ['pages_show_list', 'pages_read_engagement', ...(provider === 'facebook'
      ? ['pages_manage_posts'] : ['instagram_basic', 'instagram_content_publish'])];
    if (required.some((name) => !permissions.data.some((p) => p.permission === name && p.status === 'granted'))) {
      return base + '?status=meta-permissions';
    }
    const pageSchema = z.object({
      data: z.array(z.object({
        id: identifier, name: z.string(), access_token: z.string().optional(),
        instagram_business_account: z.object({ id: identifier, username: z.string().optional() }).optional(),
      })),
      paging: z.object({ next: z.string().optional(), cursors: z.object({ after: z.string() }).optional() }).optional(),
    });
    const accounts: z.infer<typeof accountSchema>[] = [];
    let cursor: string | undefined;
    for (let batch = 0; batch < 10; batch++) {
      const page = pageSchema.parse(await graph('me/accounts', {
        fields: 'id,name,access_token' + (provider === 'instagram' ? ',instagram_business_account{id,username}' : ''),
        limit: '100', ...(cursor ? { after: cursor } : {}),
      }, long.access_token));
      for (const item of page.data) {
        if (!item.access_token) continue;
        if (provider === 'facebook') accounts.push({ id: item.id, pageId: item.id, name: item.name, token: item.access_token });
        else if (item.instagram_business_account) accounts.push({
          id: item.instagram_business_account.id, pageId: item.id,
          name: item.instagram_business_account.username || item.name, token: item.access_token,
        });
      }
      if (!page.paging?.next) break;
      cursor = page.paging.cursors?.after;
      if (!cursor || batch === 9) throw new ProviderConfigurationError('Unable to list all accounts.');
    }
    if (!accounts.length) return base + '?status=meta-empty';
    const selection = randomBytes(32).toString('base64url');
    const hash = digest(selection);
    await prisma.oAuthState.create({ data: {
      hash, userId, workspaceId: grant.workspaceId, provider: 'meta-selection',
      expiresAt: new Date(Date.now() + 10 * 60_000),
      payload: sealToken(JSON.stringify({
        provider, accounts, expiresAt: new Date(Date.now() + long.expires_in * 1000).toISOString(),
      }), 'meta-selection/' + hash),
    } });
    return base + '/meta?selection=' + selection;
  } catch (error) {
    if (!(error instanceof ProviderConfigurationError || error instanceof z.ZodError)) throw error;
    return base + '?status=meta-unavailable';
  }
}

async function selectionGrant(tx: Prisma.TransactionClient, userId: string, slug: string, selection: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(selection)) throw new WorkspaceAccessError('Invalid account selection.');
  const grant = await tx.oAuthState.findFirst({ where: {
    hash: digest(selection), userId, provider: 'meta-selection', workspace: { slug }, expiresAt: { gt: new Date() },
  } });
  if (!grant?.payload) throw new WorkspaceAccessError('Account selection expired. Connect again.');
  await manager(tx, userId, grant.workspaceId);
  const data = selectionSchema.parse(JSON.parse(openToken(grant.payload, 'meta-selection/' + grant.hash)));
  if (new Date(data.expiresAt) <= new Date()) throw new WorkspaceAccessError('Authorization expired. Connect again.');
  return { grant, data };
}

export async function metaAccountChoices(userId: string, slug: string, selection: string) {
  const { data } = await selectionGrant(prisma, userId, slug, selection);
  return { provider: data.provider, accounts: data.accounts.map(({ id, name }) => ({ id, name })) };
}

export async function saveMetaAccounts(userId: string, slug: string, selection: string, ids: string[]) {
  const selected = z.array(identifier).min(1).max(1000).parse(ids);
  await prisma.$transaction(async (tx) => {
    const { grant, data } = await selectionGrant(tx, userId, slug, selection);
    const accounts = data.accounts.filter(({ id }) => selected.includes(id));
    if (new Set(selected).size !== accounts.length) throw new WorkspaceAccessError('Select accounts from the authorized list.');
    if (!(await tx.oAuthState.deleteMany({ where: { hash: grant.hash, userId, expiresAt: { gt: new Date() } } })).count) {
      throw new WorkspaceAccessError('Account selection was already saved.');
    }
    for (const account of accounts) {
      const channel = await tx.channel.upsert({
        where: { workspaceId_provider_externalId: { workspaceId: grant.workspaceId, provider: data.provider, externalId: account.id } },
        create: { workspaceId: grant.workspaceId, provider: data.provider, externalId: account.id, name: account.name, guildId: account.pageId },
        update: { name: account.name, guildId: account.pageId },
      });
      const values = {
        accessToken: sealToken(account.token, data.provider + '/' + grant.workspaceId + '/' + channel.id + '/access'),
        accessExpiresAt: new Date(data.expiresAt), revokedAt: null, refreshToken: null, refreshExpiresAt: null,
      };
      await tx.providerCredential.upsert({ where: { channelId: channel.id }, create: { channelId: channel.id, ...values }, update: values });
      await tx.auditEvent.create({ data: {
        workspaceId: grant.workspaceId, actorId: userId, subjectId: channel.id, action: 'channel.oauth_connected',
      } });
    }
  });
}

export async function disconnectMetaAccount(userId: string, slug: string, channelId: string) {
  await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findFirst({ where: { id: channelId, workspace: { slug }, provider: { in: metaProvider.options } } });
    if (!channel) throw new WorkspaceAccessError('Channel unavailable.');
    await manager(tx, userId, channel.workspaceId);
    await tx.providerCredential.deleteMany({ where: { channelId } });
    await tx.auditEvent.create({ data: {
      workspaceId: channel.workspaceId, actorId: userId, subjectId: channelId, action: 'channel.oauth_disconnected',
    } });
  });
}
