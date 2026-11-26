import { assertChannelCapacity } from './plans';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './client';
import { linkedInAuthorization, linkedInDestinations, linkedInTokens, LinkedInAuthorizationError, type LinkedInMode, type LinkedInTokens } from './linkedin-api';
import { ProviderConfigurationError } from './provider-contract';
import { openToken, sealToken } from './token-vault';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

export { linkedInPagesConfigured } from './linkedin-api';

const provider = 'linkedin';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = (workspaceId: string, channelId: string) => `${provider}/${workspaceId}/${channelId}`;

async function requireManager(client: Prisma.TransactionClient, userId: string, workspaceId: string) {
  const membership = await client.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot manage this connection.');
}

export async function beginLinkedInConnection(userId: string, slug: string, mode: LinkedInMode = 'member', connectLinkHash?: string) {
  const workspace = await prisma.workspace.findUnique({ where: { slug }, select: { id: true } });
  if (!workspace) throw new WorkspaceAccessError('Workspace unavailable.');
  await requireManager(prisma, userId, workspace.id);
  const state = randomBytes(32).toString('base64url');
  const url = linkedInAuthorization(state, mode);
  const now = new Date();
  await prisma.$transaction([
    prisma.oAuthState.deleteMany({ where: { userId, expiresAt: { lte: now } } }),
    prisma.oAuthState.create({ data: {
      hash: digest(state), provider, userId, workspaceId: workspace.id, payload: mode === 'pages' ? 'pages' : null,
      connectLinkHash: connectLinkHash ?? null,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    } }),
  ]);
  return url;
}

/** Company-page channels use the pages app (when configured); profile channels use the main app. */
function channelMode(externalId: string): LinkedInMode {
  return externalId.startsWith('organization:') && process.env.LINKEDIN_PAGES_CLIENT_ID ? 'pages' : 'member';
}

function encryptedTokens(tokens: LinkedInTokens, binding: string) {
  return {
    accessToken: sealToken(tokens.access, binding + '/access'),
    accessExpiresAt: tokens.expiresAt,
    refreshToken: tokens.refresh ? sealToken(tokens.refresh, binding + '/refresh') : null,
    refreshExpiresAt: tokens.refreshExpiresAt ?? null,
    revokedAt: null,
  };
}

export async function completeLinkedInConnection(userId: string, state: string, code?: string, error?: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new ProviderConfigurationError('The LinkedIn connection request is invalid.');
  const hash = digest(state);
  const where = { hash, provider, userId, expiresAt: { gt: new Date() } };
  const grant = await prisma.oAuthState.findFirst({ where, include: { workspace: { select: { slug: true } } } });
  if (!grant) throw new ProviderConfigurationError('The LinkedIn connection request is expired or unavailable.');
  const consumed = await prisma.oAuthState.deleteMany({ where });
  if (!consumed.count) throw new ProviderConfigurationError('The LinkedIn connection request was already used.');
  await requireManager(prisma, userId, grant.workspaceId);
  const mode: LinkedInMode = grant.payload === 'pages' ? 'pages' : 'member';
  if (!code) {
    // LinkedIn answers unauthorized_scope_error while the app's page access (Community Management API) is unapproved.
    const reason = mode === 'pages' && error === 'unauthorized_scope_error' ? 'pages-not-approved' : undefined;
    return { slug: grant.workspace.slug, connected: false, reason };
  }
  try {
    const tokens = await linkedInTokens({ code }, mode);
    const destinations = await linkedInDestinations(tokens.access, mode);
    if (!destinations.length) return { slug: grant.workspace.slug, connected: false, reason: mode === 'pages' ? 'no-pages' : undefined };
    await prisma.$transaction(async (tx) => {
      await requireManager(tx, userId, grant.workspaceId);
      await assertChannelCapacity(tx, grant.workspaceId, destinations.map((d) => ({ provider, externalId: d.externalId })));
      for (const destination of destinations) {
        const channel = await tx.channel.upsert({
          where: { workspaceId_provider_externalId: { workspaceId: grant.workspaceId, provider, externalId: destination.externalId } },
          create: { workspaceId: grant.workspaceId, provider, ...destination },
          update: { name: destination.name },
        });
        const values = encryptedTokens(tokens, scope(grant.workspaceId, channel.id));
        await tx.providerCredential.upsert({
          where: { channelId: channel.id }, create: { channelId: channel.id, ...values }, update: values,
        });
        await tx.auditEvent.create({
          data: { workspaceId: grant.workspaceId, actorId: userId, subjectId: channel.id, action: 'channel.oauth_connected' },
        });
      }
    });
    return { slug: grant.workspace.slug, connected: true, reason: undefined as string | undefined };
  } catch (failure) {
    if (!(failure instanceof ProviderConfigurationError)) throw failure;
    return { slug: grant.workspace.slug, connected: false, reason: undefined as string | undefined };
  }
}

export async function disconnectLinkedIn(userId: string, slug: string, channelId: string) {
  await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findFirst({ where: { id: channelId, provider, workspace: { slug } } });
    if (!channel) throw new WorkspaceAccessError('Connection unavailable.');
    await requireManager(tx, userId, channel.workspaceId);
    await tx.providerCredential.deleteMany({ where: { channelId } });
    await tx.auditEvent.create({
      data: { workspaceId: channel.workspaceId, actorId: userId, subjectId: channelId, action: 'channel.oauth_disconnected' },
    });
  });
}

export async function linkedInAccess(channelId: string, workspaceId: string, rejectedSnapshot?: string) {
  const binding = scope(workspaceId, channelId);
  return prisma.$transaction(async (tx) => {
    // Refresh exchanges for the same account serialize without locking other connections.
    await tx.$queryRaw`
      SELECT credential."channel_id"
      FROM "provider_credentials" AS credential
      JOIN "channels" AS channel ON channel."id" = credential."channel_id"
      WHERE credential."channel_id" = ${channelId}::uuid
        AND channel."workspace_id" = ${workspaceId}::uuid
        AND channel."provider" = ${provider}
      FOR UPDATE OF credential
    `;
    const current = await tx.providerCredential.findFirst({
      where: { channelId, channel: { provider, workspaceId } }, include: { channel: { select: { externalId: true } } },
    });
    if (!current || current.revokedAt) return null;
    const now = new Date();
    const force = current.accessToken === rejectedSnapshot;
    if (!force && current.accessExpiresAt.getTime() > now.getTime() + 60_000) {
      return { access: openToken(current.accessToken, binding + '/access'), snapshot: current.accessToken };
    }
    if (!current.refreshToken || (current.refreshExpiresAt && current.refreshExpiresAt <= now)) {
      return !force && current.accessExpiresAt > now
        ? { access: openToken(current.accessToken, binding + '/access'), snapshot: current.accessToken }
        : null;
    }
    try {
      const tokens = await linkedInTokens({ refresh: openToken(current.refreshToken, binding + '/refresh') }, channelMode(current.channel.externalId));
      const next = encryptedTokens(tokens, binding);
      // LinkedIn may omit a new refresh token or TTL. Keep the existing value and original expiry.
      await tx.providerCredential.update({
        where: { channelId },
        data: {
          ...next, refreshToken: next.refreshToken ?? current.refreshToken,
          refreshExpiresAt: next.refreshExpiresAt ?? current.refreshExpiresAt,
        },
      });
      return { access: tokens.access, snapshot: next.accessToken };
    } catch (error) {
      if (!(error instanceof LinkedInAuthorizationError)) throw error;
      await tx.providerCredential.update({ where: { channelId }, data: { revokedAt: now } });
      return null;
    }
  }, { maxWait: 10_000, timeout: 12_000 });
}

export async function invalidateLinkedInAccess(channelId: string, snapshot: string) {
  await prisma.providerCredential.updateMany({
    where: { channelId, accessToken: snapshot },
    data: { revokedAt: new Date() },
  });
}
