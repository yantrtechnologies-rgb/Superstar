// Client connect links: an agency (workspace owner/admin) creates a link for one network and sends it to a client.
// The client opens it without a Superstar account, signs in on the network, and the account is connected to the
// agency's workspace. The connection runs as the link's creator, so it keeps every check the dashboard flow has
// (workspace role, plan channel limit, encrypted tokens, audit log) and stops working if that person loses access.
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './client';
import { beginInstagramDirectConnection, instagramDirectConfigured } from './instagram-direct';
import { linkedInConfigured, linkedInPagesConfigured } from './linkedin-api';
import { beginLinkedInConnection } from './linkedin-connection';
import { beginMetaConnection, metaAccountChoices, metaConfiguration, saveMetaAccounts } from './meta-connection';
import { assertChannelCapacity } from './plans';
import { ProviderConfigurationError } from './provider-contract';
import { openToken, sealToken } from './token-vault';
import { canManageTeam, WorkspaceAccessError } from './workspaces';
import { beginXConnection, xConfigured } from './x';
import { beginYouTubeConnection, youtubeConfigured } from './youtube';

export const connectLinkProvider = z.enum(['facebook', 'instagram', 'instagram-direct', 'linkedin', 'linkedin-pages', 'youtube', 'x']);
export type ConnectLinkProvider = z.infer<typeof connectLinkProvider>;

const LIFETIME_MS = 7 * 86_400_000;
const MAX_ACTIVE_LINKS = 100;
// Each attempt opens a 10-minute OAuth state; this caps how fast one link can be replayed.
const MAX_OPEN_ATTEMPTS = 10;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sealing = (hash: string) => 'connect-link/' + hash;

const names: Record<ConnectLinkProvider, string> = {
  facebook: 'Facebook Pages', instagram: 'Instagram (via Facebook Page)', 'instagram-direct': 'Instagram', linkedin: 'LinkedIn profile', 'linkedin-pages': 'LinkedIn Page',
  youtube: 'YouTube', x: 'X',
};
export function connectLinkProviderName(provider: ConnectLinkProvider) { return names[provider]; }

/** Networks a link can be created for on this server (the same ones the Channels page can connect). */
export function connectLinkProviders(): ConnectLinkProvider[] {
  const configured: Record<ConnectLinkProvider, () => boolean> = {
    facebook: () => Boolean(metaConfiguration()), instagram: () => Boolean(metaConfiguration()), 'instagram-direct': instagramDirectConfigured,
    linkedin: linkedInConfigured, 'linkedin-pages': linkedInPagesConfigured, youtube: youtubeConfigured, x: xConfigured,
  };
  return connectLinkProvider.options.filter((provider) => configured[provider]());
}

function linkUrl(token: string) {
  try {
    return new URL('/connect/' + token, process.env.APP_URL).href;
  } catch {
    return '/connect/' + token;
  }
}

async function managedWorkspace(client: Prisma.TransactionClient, userId: string, slug: string) {
  const workspace = await client.workspace.findUnique({ where: { slug }, select: { id: true } });
  if (!workspace) throw new WorkspaceAccessError('Workspace unavailable.');
  const member = await client.membership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId } } });
  if (!member || !canManageTeam(member.role)) throw new WorkspaceAccessError('Only workspace owners and admins can manage connect links.');
  return workspace.id;
}

export async function createConnectLink(userId: string, slug: string, provider: ConnectLinkProvider, label?: string) {
  const workspaceId = await managedWorkspace(prisma, userId, slug);
  if (!connectLinkProviders().includes(provider)) throw new ProviderConfigurationError(names[provider] + ' is not configured on this server.');
  const name = label?.trim().slice(0, 80) || null;
  const now = new Date();
  const active = await prisma.connectLink.count({ where: { workspaceId, revokedAt: null, expiresAt: { gt: now } } });
  if (active >= MAX_ACTIVE_LINKS) throw new WorkspaceAccessError('This workspace has too many open connect links. Revoke some first.');
  const token = randomBytes(32).toString('base64url');
  const hash = digest(token);
  await prisma.$transaction([
    prisma.connectLink.create({ data: {
      hash, token: sealToken(token, sealing(hash)), workspaceId, createdById: userId, provider, label: name,
      expiresAt: new Date(now.getTime() + LIFETIME_MS),
    } }),
    prisma.auditEvent.create({ data: { workspaceId, actorId: userId, action: 'channel.connect_link_created' } }),
  ]);
  return linkUrl(token);
}

export async function listConnectLinks(userId: string, slug: string) {
  const workspaceId = await managedWorkspace(prisma, userId, slug);
  const links = await prisma.connectLink.findMany({
    where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' },
    include: { createdBy: { select: { name: true, email: true } } },
  });
  return links.map((link) => ({
    id: link.hash, provider: link.provider as ConnectLinkProvider, providerName: names[link.provider as ConnectLinkProvider] ?? link.provider,
    label: link.label, url: linkUrl(openToken(link.token, sealing(link.hash))), createdAt: link.createdAt,
    expiresAt: link.expiresAt, lastUsedAt: link.lastUsedAt, createdBy: link.createdBy.name || link.createdBy.email,
  }));
}

export async function revokeConnectLink(userId: string, slug: string, id: string) {
  const workspaceId = await managedWorkspace(prisma, userId, slug);
  if (!/^[0-9a-f]{64}$/.test(id)) throw new WorkspaceAccessError('Connect link unavailable.');
  await prisma.$transaction(async (tx) => {
    const revoked = await tx.connectLink.updateMany({ where: { hash: id, workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!revoked.count) throw new WorkspaceAccessError('Connect link unavailable.');
    // Connections a client already started through the link stop working too.
    await tx.oAuthState.deleteMany({ where: { connectLinkHash: id } });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, action: 'channel.connect_link_revoked' } });
  });
}

/** The link behind a token, while it is usable: not revoked or expired, and its creator still manages the workspace. */
async function usableLink(token: string) {
  if (!tokenPattern.test(token)) return null;
  const link = await prisma.connectLink.findUnique({
    where: { hash: digest(token) }, include: { workspace: { select: { slug: true, name: true } } },
  });
  if (!link || link.revokedAt || link.expiresAt <= new Date()) return null;
  const member = await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId: link.workspaceId, userId: link.createdById } } });
  if (!member || !canManageTeam(member.role)) return null;
  const provider = connectLinkProvider.safeParse(link.provider);
  return provider.success ? { ...link, provider: provider.data } : null;
}

/** What the public link page shows. Never includes tokens or other workspace data. */
export async function connectLinkPreview(token: string) {
  const link = await usableLink(token);
  if (!link) return null;
  return {
    workspaceName: link.workspace.name, provider: link.provider, providerName: names[link.provider],
    label: link.label, expiresAt: link.expiresAt,
  };
}

/** The client agreed on the link page: returns the network's sign-in URL. */
export async function startConnectLink(token: string) {
  const link = await usableLink(token);
  if (!link) throw new WorkspaceAccessError('This link is no longer valid. Ask whoever sent it for a new one.');
  const now = new Date();
  const open = await prisma.oAuthState.count({ where: { connectLinkHash: link.hash, expiresAt: { gt: now } } });
  if (open >= MAX_OPEN_ATTEMPTS) throw new ProviderConfigurationError('Too many attempts with this link. Wait 10 minutes and try again.');
  // Refuse up front when the workspace has no channel left on its plan (the save checks again).
  await assertChannelCapacity(prisma, link.workspaceId, [{ provider: 'connect-link', externalId: randomBytes(8).toString('hex') }]);
  await prisma.connectLink.update({ where: { hash: link.hash }, data: { lastUsedAt: now } });
  const { createdById: userId, workspace: { slug }, hash } = link;
  switch (link.provider) {
    case 'facebook': case 'instagram': return beginMetaConnection(userId, slug, link.provider, hash);
    case 'instagram-direct': return beginInstagramDirectConnection(userId, slug, hash);
    case 'linkedin': return beginLinkedInConnection(userId, slug, 'member', hash);
    case 'linkedin-pages': return beginLinkedInConnection(userId, slug, 'pages', hash);
    case 'youtube': return beginYouTubeConnection(userId, slug, hash);
    case 'x': return beginXConnection(userId, slug, hash);
  }
}

/**
 * For a network callback: when the OAuth state was started from a usable connect link, the user the connection
 * runs as (the link's creator). Null for an ordinary dashboard connection, which needs the signed-in user instead.
 */
export async function connectLinkActor(state: string) {
  if (!tokenPattern.test(state)) return null;
  const grant = await prisma.oAuthState.findUnique({
    where: { hash: digest(state) }, include: { connectLink: { select: { revokedAt: true } } },
  });
  if (!grant?.connectLink || grant.connectLink.revokedAt || grant.expiresAt <= new Date()) return null;
  return grant.userId;
}

async function linkedSelection(selection: string) {
  if (!tokenPattern.test(selection)) throw new WorkspaceAccessError('Account selection expired. Open the link again.');
  const grant = await prisma.oAuthState.findFirst({
    where: { hash: digest(selection), provider: 'meta-selection', connectLinkHash: { not: null }, expiresAt: { gt: new Date() } },
    include: { workspace: { select: { slug: true } }, connectLink: { select: { revokedAt: true } } },
  });
  if (!grant || !grant.connectLink || grant.connectLink.revokedAt) throw new WorkspaceAccessError('Account selection expired. Open the link again.');
  return { userId: grant.userId, slug: grant.workspace.slug };
}

/** Facebook Pages / Instagram accounts a client may pick after signing in through a connect link. */
export async function connectLinkMetaChoices(selection: string) {
  const { userId, slug } = await linkedSelection(selection);
  return metaAccountChoices(userId, slug, selection);
}

export async function saveConnectLinkMetaAccounts(selection: string, ids: string[]) {
  const { userId, slug } = await linkedSelection(selection);
  await saveMetaAccounts(userId, slug, selection, ids);
}
