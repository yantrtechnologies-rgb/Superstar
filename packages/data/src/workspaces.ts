import { randomUUID } from 'node:crypto';
import { Prisma, type WorkspaceRole } from '@prisma/client';
import { prisma } from './client';

export const invitationRoles = ['EDITOR', 'REVIEWER', 'VIEWER'] as const;
export const ownerInvitationRoles = ['ADMIN', ...invitationRoles] as const;
type InvitationRole = (typeof ownerInvitationRoles)[number];

export function canManageTeam(role: WorkspaceRole) {
  return role === 'OWNER' || role === 'ADMIN';
}

export function canInvite(role: WorkspaceRole, invitedRole: WorkspaceRole) {
  return (canManageTeam(role) && invitationRoles.some((allowed) => allowed === invitedRole))
    || (role === 'OWNER' && invitedRole === 'ADMIN');
}

export { WorkspaceAccessError } from './errors';
import { WorkspaceAccessError } from './errors';
import { assertSeatCapacity } from './plans';

export function findMembership(userId: string, slug: string) {
  return prisma.membership.findFirst({
    where: { userId, workspace: { slug } },
    include: { workspace: true },
  });
}

export function listMemberships(userId: string) {
  return prisma.membership.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: [{ workspace: { name: 'asc' } }, { workspaceId: 'asc' }],
  });
}

export async function createWorkspace(userId: string, name: string, timeZone: string) {
  const prefix = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return prisma.workspace.create({
    data: {
      name,
      slug: `${prefix || 'workspace'}-${randomUUID().slice(0, 8)}`,
      timeZone,
      memberships: { create: { userId, role: 'OWNER' } },
      auditEvents: { create: { actorId: userId, action: 'workspace.created' } },
    },
  });
}

export function listInvitations(email: string) {
  return prisma.invitation.findMany({
    where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, role: true, workspace: { select: { name: true } } },
  });
}

export function listWorkspaceTeam(userId: string, slug: string) {
  return prisma.membership.findFirst({
    where: { userId, workspace: { slug } },
    select: {
      role: true,
      workspace: {
        select: {
          name: true,
          slug: true,
          timeZone: true,
          memberships: {
            orderBy: { createdAt: 'asc' },
            select: { role: true, user: { select: { email: true, name: true } } },
          },
        },
      },
    },
  });
}

export async function inviteMember(userId: string, slug: string, email: string, role: InvitationRole) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { userId, workspace: { slug } },
      include: { workspace: true },
    });
    if (!membership || !canInvite(membership.role, role)) {
      throw new WorkspaceAccessError('You do not have permission to send this invitation.');
    }
    const { workspace } = membership;
    const alreadyMember = await tx.membership.findFirst({ where: { workspaceId: workspace.id, user: { email } } });
    if (alreadyMember) throw new WorkspaceAccessError('This person already belongs to the workspace.');
    await assertSeatCapacity(tx, workspace.id, { invitingEmail: email });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invitation = await tx.invitation.upsert({
      where: { workspaceId_email: { workspaceId: workspace.id, email } },
      update: { invitedById: userId, role, expiresAt, acceptedAt: null },
      create: { workspaceId: workspace.id, invitedById: userId, role, email, expiresAt },
    });
    await tx.auditEvent.create({
      data: { workspaceId: workspace.id, actorId: userId, action: 'invitation.sent', subjectId: invitation.id },
    });
    return workspace.name;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function acceptInvitation(userId: string, invitationId: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } });
    if (!user?.emailVerified) throw new WorkspaceAccessError('Verify your email before accepting an invitation.');
    const now = new Date();
    const pending = { id: invitationId, email: user.email, acceptedAt: null, expiresAt: { gt: now } };
    const invitation = await tx.invitation.findFirst({ where: pending, include: { workspace: true } });
    if (!invitation || !canInvite('OWNER', invitation.role)) {
      throw new WorkspaceAccessError('This invitation is unavailable for your account.');
    }
    const claimed = await tx.invitation.updateMany({ where: { ...pending, role: invitation.role }, data: { acceptedAt: now } });
    if (!claimed.count) throw new WorkspaceAccessError('This invitation changed. Refresh and try again.');
    const { workspace } = invitation;
    if (!(await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId } } }))) {
      await assertSeatCapacity(tx, workspace.id, { joining: true });
    }
    await tx.membership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
      update: {},
      create: { workspaceId: workspace.id, userId, role: invitation.role },
    });
    await tx.auditEvent.create({
      data: { workspaceId: workspace.id, actorId: userId, action: 'invitation.accepted', subjectId: invitation.id },
    });
    return workspace;
  });
}
