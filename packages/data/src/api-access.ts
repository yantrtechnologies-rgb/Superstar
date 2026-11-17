import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { apiKeyPattern, keyInput, type ApiScope } from '@cadencedesk/contracts';
import { prisma } from './client';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const managingRoles = ['OWNER', 'ADMIN'] as const;

async function requireManager(tx: Prisma.TransactionClient, userId: string, slug: string) {
  const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot manage API keys.');
  return membership.workspaceId;
}

export async function createApiKey(userId: string, slug: string, name: string, days: number, scopes: ApiScope[]) {
  const input = keyInput.safeParse({ name, days, scopes });
  if (!input.success) throw new WorkspaceAccessError('Choose a name, expiration and at least one valid scope.');
  return prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    const token = 'cdk_' + randomBytes(32).toString('base64url');
    const record = await tx.apiKey.create({
      data: {
        workspaceId, createdById: userId, name: input.data.name, scopes: [...new Set(input.data.scopes)],
        prefix: token.slice(0, 12), tokenHash: digest(token),
        expiresAt: new Date(Date.now() + input.data.days * 86_400_000),
      },
      select: { id: true },
    });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: record.id, action: 'api_key.created' } });
    return token;
  });
}

export async function revokeApiKey(userId: string, slug: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    const changed = await tx.apiKey.updateMany({
      where: { id, workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!changed.count) throw new WorkspaceAccessError('This API key is unavailable.');
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: id, action: 'api_key.revoked' } });
  });
}

export function listApiKeys(userId: string, slug: string) {
  return prisma.apiKey.findMany({
    where: { workspace: { slug, memberships: { some: { userId, role: { in: [...managingRoles] } } } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, revokedAt: true, createdAt: true },
  });
}

export async function resolveApiKey(token: string, slug: string) {
  if (!apiKeyPattern.test(token)) return null;
  return prisma.apiKey.findFirst({
    where: {
      tokenHash: digest(token), revokedAt: null, expiresAt: { gt: new Date() },
      workspace: { slug },
      creator: { memberships: { some: { workspace: { slug }, role: { in: [...managingRoles] } } } },
    },
    select: { id: true, workspaceId: true, createdById: true, scopes: true },
  });
}

const apiPostFields = {
  id: true, state: true, revision: true, createdAt: true, scheduledAt: true,
  revisions: {
    orderBy: { number: 'desc' }, take: 1,
    select: { content: true, channelIds: true, followUpText: true, followUpDelayMinutes: true },
  },
  destinations: {
    orderBy: { id: 'asc' },
    select: { id: true, channelId: true, state: true, permalink: true, parentId: true, error: true, externalId: true },
  },
} satisfies Prisma.PostSelect;

type RawPost = Prisma.PostGetPayload<{ select: typeof apiPostFields }>;

function serializePost({ revisions, ...post }: RawPost) {
  return { ...post, content: revisions[0] ?? null };
}

export async function apiPosts(workspaceId: string, { limit, offset }: { limit: number; offset: number }) {
  const items = await prisma.post.findMany({
    where: { workspaceId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: apiPostFields, take: limit + 1, skip: offset,
  });
  return { items: items.slice(0, limit).map(serializePost), nextOffset: items.length > limit && offset + limit <= 100_000 ? offset + limit : null };
}

export async function apiPost(workspaceId: string, id: string) {
  const result = await prisma.post.findFirst({ where: { id, workspaceId }, select: apiPostFields });
  return result ? serializePost(result) : null;
}

export async function apiChannels(workspaceId: string, { limit, offset }: { limit: number; offset: number }) {
  const items = await prisma.channel.findMany({
    where: { workspaceId },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, provider: true, clientGroupId: true }, take: limit + 1, skip: offset,
  });
  return { items: items.slice(0, limit), nextOffset: items.length > limit && offset + limit <= 100_000 ? offset + limit : null };
}
