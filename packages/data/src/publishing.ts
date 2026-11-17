import { Prisma, type PostState, type WorkspaceRole } from '@prisma/client';
import { prisma } from './client';
import { uploadImage } from './assets';
import { ProviderConfigurationError, type ProviderId } from './provider-contract';
import { getProvider, validateProviderPost } from './providers';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

export function canWritePosts(role: WorkspaceRole) {
  return canManageTeam(role) || role === 'EDITOR';
}

export function canApprovePosts(role: WorkspaceRole) {
  return canManageTeam(role) || role === 'REVIEWER';
}

async function requireScope(tx: Prisma.TransactionClient, userId: string, slug: string) {
  const member = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!member) throw new WorkspaceAccessError('Workspace is unavailable.');
  return member;
}

export async function connectChannel(userId: string, slug: string, providerId: ProviderId, channelId: string) {
  const scoped = await requireScope(prisma, userId, slug);
  if (!canManageTeam(scoped.role)) throw new WorkspaceAccessError('You cannot connect channels.');
  const provider = getProvider(providerId);
  if (!provider) throw new ProviderConfigurationError('This provider is unavailable.');
  const channel = await provider.discover(slug, channelId);
  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await requireScope(tx, userId, slug);
    if (!canManageTeam(role)) throw new WorkspaceAccessError('You cannot connect channels.');
    await tx.channel.upsert({
      where: { workspaceId_provider_externalId: { workspaceId, provider: providerId, externalId: channelId } },
      create: { workspaceId, provider: providerId, externalId: channelId, ...channel },
      update: channel,
    });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, action: 'channel.connected' } });
  }, serializable);
}

export function listChannels(userId: string, slug: string) {
  return prisma.channel.findMany({
    where: { workspace: { slug, memberships: { some: { userId } } } },
    orderBy: { name: 'asc' },
  });
}

export function listPosts(userId: string, slug: string, scheduledOnly = false) {
  return prisma.post.findMany({
    where: {
      workspace: { slug, memberships: { some: { userId } } },
      ...(scheduledOnly ? { scheduledAt: { not: null } } : {}),
    },
    orderBy: scheduledOnly ? { scheduledAt: 'asc' } : { createdAt: 'desc' },
    include: {
      revisions: { orderBy: { number: 'desc' }, take: 1, include: { asset: { select: { type: true } } } },
      destinations: { include: { channel: true }, orderBy: { id: 'asc' } },
    },
  });
}

export async function savePost(userId: string, slug: string, content: string, postId?: string, revision?: number, image?: Uint8Array<ArrayBuffer>) {
  if (!content.trim() || content.length > 4096) throw new WorkspaceAccessError('Use 1–4,096 characters.');
  const scoped = await requireScope(prisma, userId, slug);
  if (!canWritePosts(scoped.role)) throw new WorkspaceAccessError('You cannot edit drafts.');
  const uploaded = image ? await uploadImage(scoped.workspaceId, image) : null;
  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await requireScope(tx, userId, slug);
    if (!canWritePosts(role)) throw new WorkspaceAccessError('You cannot edit drafts.');
    if (scoped.workspaceId !== workspaceId) throw new WorkspaceAccessError('Workspace is unavailable.');
    const asset = uploaded ? await tx.asset.create({ data: { workspaceId, ...uploaded } }) : null;
    if (!postId || revision === undefined) {
      return tx.post.create({ data: { workspaceId, revisions: { create: { number: 1, content, assetId: asset?.id } } } });
    }
    const updated = await tx.post.updateMany({
      where: { id: postId, workspaceId, revision, state: { in: ['DRAFT', 'IN_REVIEW', 'APPROVED'] } },
      data: { state: 'DRAFT', revision: { increment: 1 } },
    });
    if (!updated.count) throw new WorkspaceAccessError('This draft changed or is unavailable.');
    const current = await tx.postRevision.findUniqueOrThrow({ where: { postId_number: { postId, number: revision } } });
    await tx.postRevision.create({
      data: { postId, number: revision + 1, content, assetId: asset?.id ?? current.assetId },
    });
    return tx.post.findUniqueOrThrow({ where: { id: postId } });
  }, serializable);
}

export async function transitionPost(
  userId: string, slug: string, postId: string, revision: number, state: 'IN_REVIEW' | 'APPROVED', targets: string[] = [],
) {
  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await requireScope(tx, userId, slug);
    const approve = state === 'APPROVED';
    if (approve ? !canApprovePosts(role) : !canWritePosts(role)) {
      throw new WorkspaceAccessError('You cannot change this post status.');
    }
    const previous: PostState = approve ? 'IN_REVIEW' : 'DRAFT';
    const updated = await tx.post.updateMany({ where: { id: postId, workspaceId, revision, state: previous }, data: { state } });
    if (!updated.count) throw new WorkspaceAccessError('This draft changed or is unavailable.');
    if (approve) {
      await tx.approval.create({ data: { postId, revision, reviewerId: userId } });
    } else {
      const channelIds = [...new Set(targets)].sort();
      const channels = await tx.channel.findMany({
        where: { workspaceId, id: { in: channelIds } },
        select: { provider: true },
      });
      if (!channels.length || channels.length > 20 || channels.length !== channelIds.length) {
        throw new WorkspaceAccessError('Choose available workspace channels.');
      }
      const draft = await tx.postRevision.findUniqueOrThrow({
        where: { postId_number: { postId, number: revision } },
      });
      for (const channel of channels) validateProviderPost(channel.provider, draft.content, Boolean(draft.assetId));
      await tx.postRevision.update({
        where: { postId_number: { postId, number: revision } }, data: { channelIds },
      });
    }
    await tx.auditEvent.create({
      data: { workspaceId, actorId: userId, subjectId: postId, action: approve ? 'post.approved' : 'post.submitted' },
    });
  }, serializable);
}

export async function schedulePost(
  userId: string, slug: string, postId: string, revision: number, targets: string[], scheduledAt: Date,
) {
  const channelIds = [...new Set(targets)].sort();
  if (channelIds.length < 1 || channelIds.length > 20 || !Number.isFinite(scheduledAt.getTime())) {
    throw new WorkspaceAccessError('Select between 1 and 20 destinations and a valid date.');
  }
  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await requireScope(tx, userId, slug);
    if (!canWritePosts(role)) throw new WorkspaceAccessError('You cannot schedule posts.');
    const [channels, approval] = await Promise.all([
      tx.channel.count({ where: { workspaceId, id: { in: channelIds } } }),
      tx.approval.findFirst({ where: { postId, revision, version: { post: { workspaceId } } }, include: { version: true } }),
    ]);
    if (channels !== channelIds.length || !approval || approval.version.channelIds.join() !== channelIds.join()) {
      throw new WorkspaceAccessError('The approval or selected channels are unavailable.');
    }
    const changed = await tx.post.updateMany({
      where: { id: postId, workspaceId, state: 'APPROVED', revision },
      data: { state: 'SCHEDULED', scheduledAt },
    });
    if (!changed.count) throw new WorkspaceAccessError('This approval is no longer current.');
    for (const channelId of channelIds) {
      await tx.destination.create({
        data: { postId, channelId, revision, outbox: { create: { dueAt: scheduledAt } } },
      });
    }
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: postId, action: 'post.scheduled' } });
  }, serializable);
}

export async function cancelPost(userId: string, slug: string, postId: string) {
  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await requireScope(tx, userId, slug);
    if (!canWritePosts(role)) throw new WorkspaceAccessError('You cannot cancel posts.');
    const canceled = await tx.destination.updateMany({
      where: { postId, state: 'SCHEDULED', post: { workspaceId } },
      data: { state: 'CANCELED' },
    });
    if (!canceled.count) throw new WorkspaceAccessError('There are no pending destinations to cancel.');
    const remaining = await tx.destination.count({ where: { postId, state: { not: 'CANCELED' } } });
    if (!remaining) await tx.post.update({ where: { id: postId }, data: { state: 'CANCELED' } });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: postId, action: 'post.canceled' } });
  }, serializable);
}
