import { Prisma } from '@prisma/client';
import { prisma } from './client';
import { PostingSlotUnavailableError } from './next-slot';
import { allowedOutboundUrl } from './outbound';
import { canWritePosts, scheduleApprovedPost } from './publishing';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

export class RssConfigurationError extends Error {}

export function allowedFeedUrl(value: string) {
  try {
    return allowedOutboundUrl(value, process.env.RSS_ALLOWED_FEEDS);
  } catch {
    throw new RssConfigurationError('Ask the workspace operator to allow this exact HTTPS feed URL.');
  }
}

export function rssConfigured() {
  return Boolean(process.env.RSS_ALLOWED_FEEDS?.trim());
}

export async function addRssRule(userId: string, slug: string, name: string, value: string, publishTargets: string[] = []) {
  const url = allowedFeedUrl(value);
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot add RSS rules.');
    const { workspaceId } = membership;
    const channelIds = [...new Set(publishTargets)].sort();
    if (channelIds.length > 20 || (channelIds.length && await tx.channel.count({
      where: { workspaceId, id: { in: channelIds } },
    }) !== channelIds.length)) throw new WorkspaceAccessError('Choose destinations in this workspace.');
    const details = {
      name, channelIds, publishAfterApproval: channelIds.length > 0,
      authorizedById: channelIds.length ? userId : null,
    };
    await tx.rssRule.upsert({
      where: { workspaceId_sourceUrl: { workspaceId, sourceUrl: url.href } },
      create: { workspaceId, sourceUrl: url.href, ...details }, update: details,
    });
  });
}

export async function setRssEnabled(userId: string, slug: string, id: string, enabled: boolean) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot change RSS rules.');
    const rule = await tx.rssRule.findFirst({ where: { id, workspaceId: membership.workspaceId } });
    if (!rule) throw new WorkspaceAccessError('RSS rule unavailable.');
    const result = await tx.rssRule.updateMany({
      where: { id, workspaceId: membership.workspaceId },
      data: enabled ? { enabled, nextRunAt: new Date(), authorizedById: rule.publishAfterApproval ? userId : null } : { enabled },
    });
    if (!result.count) throw new WorkspaceAccessError('RSS rule unavailable.');
  });
}

export async function queueRssRun(userId: string, slug: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canWritePosts(membership.role)) throw new WorkspaceAccessError('You cannot run this rule.');
    const rule = await tx.rssRule.findFirst({ where: { id, workspaceId: membership.workspaceId, enabled: true } });
    if (!rule) throw new WorkspaceAccessError('RSS rule unavailable.');
    const interval = 5 * 60_000;
    const bucket = new Date(Math.floor(Date.now() / interval) * interval);
    await tx.rssRun.createMany({ data: [{ ruleId: id, bucket }], skipDuplicates: true });
  });
}

export function listRssRules(userId: string, slug: string) {
  return prisma.rssRule.findMany({
    where: { workspace: { slug, memberships: { some: { userId } } } },
    orderBy: { name: 'asc' },
    include: {
      runs: { orderBy: { createdAt: 'desc' }, take: 5,
        select: { id: true, state: true, imported: true, error: true, createdAt: true },
      },
      imports: {
        where: { scheduleState: { not: 'OFF' }, postId: { not: null } },
        orderBy: { importedAt: 'desc' }, take: 5,
        select: { sourceKey: true, scheduleState: true, scheduleError: true,
          post: { select: { state: true, scheduledAt: true } } },
      },
    },
  });
}

export async function scheduleReviewedRssImports() {
  const now = new Date();
  const eligible: Prisma.FeedImportWhereInput = {
    scheduleState: { in: ['WAITING_REVIEW', 'BLOCKED'] },
    nextScheduleAt: { lte: now },
    rule: { enabled: true, publishAfterApproval: true },
    post: { state: 'APPROVED' },
  };
  const items = await prisma.feedImport.findMany({
    where: eligible, orderBy: { nextScheduleAt: 'asc' }, take: 20,
    select: { ruleId: true, sourceKey: true },
  });
  for (const key of items) {
    await prisma.$transaction(async (tx) => {
      const item = await tx.feedImport.findFirst({ where: { ...eligible, ...key }, include: { rule: true, post: true } });
      if (!item?.post || item.post.workspaceId !== item.rule.workspaceId) return;
      const { post, rule } = item;
      let report: string | null = null;
      const actorId = rule.authorizedById;
      const manager = actorId && await tx.membership.findUnique({
        where: { workspaceId_userId: { workspaceId: rule.workspaceId, userId: actorId } },
      });
      if (!actorId || !manager || !canManageTeam(manager.role)) {
        report = 'A workspace owner or admin must re-enable this rule.';
      } else {
        try {
          await scheduleApprovedPost(tx, rule.workspaceId, actorId, post.id, post.revision, rule.channelIds, 'next');
        } catch (error) {
          if (!(error instanceof WorkspaceAccessError)) throw error;
          report = error instanceof PostingSlotUnavailableError
            ? 'No shared posting slot is available. Adjust the channel slots to retry.'
            : 'The approved destinations no longer match this rule. Review the post or update the rule.';
        }
      }
      await tx.feedImport.update({
        where: { ruleId_sourceKey: key },
        data: report ? { scheduleState: 'BLOCKED', scheduleError: report, nextScheduleAt: new Date(now.getTime() + 5 * 60_000) }
          : { scheduleState: 'SCHEDULED', scheduleError: null },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
