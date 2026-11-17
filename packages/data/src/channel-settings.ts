import { Prisma } from '@prisma/client';
import { prisma } from './client';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };
export const postingDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

async function requireManager(tx: Prisma.TransactionClient, userId: string, slug: string) {
  const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot manage these channels.');
  return membership.workspaceId;
}

export function listChannelSettings(userId: string, slug: string) {
  return prisma.workspace.findFirst({
    where: { slug, memberships: { some: { userId } } },
    select: {
      timeZone: true,
      clientGroups: { orderBy: { name: 'asc' }, select: { id: true, name: true } },
      channels: {
        orderBy: { name: 'asc' },
        select: {
          id: true, name: true, provider: true, clientGroupId: true,
          postingSlots: { orderBy: [{ weekday: 'asc' }, { minute: 'asc' }] },
        },
      },
    },
  });
}

export async function createClientGroup(userId: string, slug: string, name: string) {
  if (!name.trim() || name.length > 80) throw new WorkspaceAccessError('Choose a group name.');
  return prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    await tx.clientGroup.upsert({
      where: { workspaceId_name: { workspaceId, name } },
      create: { workspaceId, name },
      update: {},
    });
  }, serializable);
}

export async function assignChannelGroup(userId: string, slug: string, channelId: string, groupId: string | null) {
  return prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    if (groupId && !await tx.clientGroup.findFirst({ where: { id: groupId, workspaceId } })) {
      throw new WorkspaceAccessError('Group unavailable.');
    }
    const updated = await tx.channel.updateMany({ where: { id: channelId, workspaceId }, data: { clientGroupId: groupId } });
    if (!updated.count) throw new WorkspaceAccessError('Channel unavailable.');
  }, serializable);
}

export async function savePostingSlot(userId: string, slug: string, channelId: string, weekday: number, minute: number) {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || !Number.isInteger(minute) || minute < 0 || minute >= 1440) {
    throw new WorkspaceAccessError('Choose a valid weekday and time.');
  }
  return prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    if (!await tx.channel.findFirst({ where: { id: channelId, workspaceId } })) throw new WorkspaceAccessError('Channel unavailable.');
    await tx.postingSlot.upsert({
      where: { channelId_weekday_minute: { channelId, weekday, minute } },
      create: { channelId, weekday, minute }, update: {},
    });
  }, serializable);
}

export async function removePostingSlot(userId: string, slug: string, slotId: string) {
  return prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    const result = await tx.postingSlot.deleteMany({ where: { id: slotId, channel: { workspaceId } } });
    if (!result.count) throw new WorkspaceAccessError('Posting slot unavailable.');
  }, serializable);
}
