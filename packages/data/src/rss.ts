import { Prisma } from '@prisma/client';
import { prisma } from './client';
import { PostingSlotUnavailableError } from './next-slot';
import { allowedOutboundUrl } from './outbound';
import { canWritePosts, scheduleApprovedPost } from './publishing';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

export class RssConfigurationError extends Error {}

/** RSS_ALLOWED_FEEDS="*" accepts any public HTTPS feed; otherwise it is a comma-separated list of exact URLs. */
const anyFeed = () => process.env.RSS_ALLOWED_FEEDS?.trim() === '*';

export function allowedFeedUrl(value: string) {
  try {
    if (!anyFeed()) return allowedOutboundUrl(value, process.env.RSS_ALLOWED_FEEDS);
    // Query strings are allowed for feeds (YouTube channel feeds use ?channel_id=). fetchFeed still only
    // connects to public IPv4 addresses and caps the download size.
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) throw new Error('unsupported');
    url.hash = '';
    return url;
  } catch {
    throw new RssConfigurationError(anyFeed()
      ? 'Use a public https:// feed address, for example https://example.com/feed.'
      : 'Ask the workspace operator to allow this exact HTTPS feed URL.');
  }
}

export function rssConfigured() {
  return Boolean(process.env.RSS_ALLOWED_FEEDS?.trim());
}

/**
 * Ready-made feeds offered as checkboxes. Google News and Bing News search for the user's topic, so their address
 * is built from it; the others are well-known marketing publications.
 */
export const feedPresets = [
  {
    id: 'google-news', name: 'Google News', note: 'Latest news stories about your topic, from thousands of sites (India edition).',
    url: (topic: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-IN&gl=IN&ceid=IN:en`,
  },
  {
    id: 'bing-news', name: 'Bing News', note: 'News articles about your topic from Microsoft Bing.',
    url: (topic: string) => `https://www.bing.com/news/search?q=${encodeURIComponent(topic)}&format=rss`,
  },
  {
    id: 'hubspot', name: 'HubSpot Marketing Blog', note: 'Marketing, social media, SEO and AI how-tos.',
    url: () => 'https://blog.hubspot.com/marketing/rss.xml',
  },
  {
    id: 'sej', name: 'Search Engine Journal', note: 'SEO, Google updates, paid search and AI search news.',
    url: () => 'https://www.searchenginejournal.com/feed/',
  },
  {
    id: 'sme', name: 'Social Media Examiner', note: 'Facebook, Instagram, LinkedIn, YouTube and short-video tips.',
    url: () => 'https://www.socialmediaexaminer.com/feed/',
  },
] as const;
export type FeedPresetId = (typeof feedPresets)[number]['id'];

/** autoSchedule: once a reviewer approves an AI post, put it in the channels' next free posting slot. */
export type RssAiSettings = { topic: string; instructions?: string; image?: boolean; autoSchedule?: boolean };

export async function addRssRule(
  userId: string, slug: string, name: string, value: string, publishTargets: string[] = [], ai?: RssAiSettings,
) {
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
      name, channelIds, publishAfterApproval: channelIds.length > 0 && (!ai?.topic || Boolean(ai.autoSchedule)),
      authorizedById: channelIds.length ? userId : null,
      aiTopic: ai?.topic.trim().slice(0, 300) || null,
      aiInstructions: ai?.instructions?.trim().slice(0, 1500) || null,
      aiImage: Boolean(ai?.topic && ai.image),
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
        where: { OR: [{ scheduleState: { not: 'OFF' }, postId: { not: null } }, { aiState: { not: null } }] },
        orderBy: { importedAt: 'desc' }, take: 8,
        select: { sourceKey: true, scheduleState: true, scheduleError: true, aiState: true, aiNote: true, title: true, postId: true,
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

/** The AI writer's queue, grouped the way the Automations tabs show it. */
export const aiQueueTabs = [
  { id: 'queued', label: 'Queued' },
  { id: 'writing', label: 'Writing' },
  { id: 'awaiting', label: 'Awaiting approval' },
  { id: 'approved', label: 'Approved & posted' },
  { id: 'skipped', label: 'Skipped' },
  { id: 'failed', label: 'Failed' },
] as const;
export type AiQueueTab = (typeof aiQueueTabs)[number]['id'];

export async function aiQueue(userId: string, slug: string) {
  const items = await prisma.feedImport.findMany({
    where: { aiState: { not: null }, rule: { workspace: { slug, memberships: { some: { userId } } } } },
    orderBy: { importedAt: 'desc' }, take: 400,
    select: {
      sourceKey: true, ruleId: true, aiState: true, aiNote: true, title: true, importedAt: true,
      rule: { select: { name: true } },
      post: {
        select: {
          id: true, state: true, revision: true, scheduledAt: true, aiNote: true,
          revisions: { orderBy: { number: 'desc' }, take: 1, select: { content: true, mediaIds: true, channelIds: true } },
          destinations: { where: { parentId: null }, select: { state: true, permalink: true } },
        },
      },
    },
  });
  // Items past the per-check limit are skipped without any AI work; they are only counted, not listed.
  let olderSkipped = 0;
  const tabs: Record<AiQueueTab, typeof items> = { queued: [], writing: [], awaiting: [], approved: [], skipped: [], failed: [] };
  for (const item of items) {
    if (item.aiState === 'PENDING') tabs.queued.push(item);
    else if (item.aiState === 'WRITING') tabs.writing.push(item);
    else if (item.aiState === 'FAILED') tabs.failed.push(item);
    else if (item.aiState === 'SKIPPED') {
      if (item.aiNote?.startsWith('Older item')) olderSkipped++;
      else tabs.skipped.push(item);
    } else if (item.post && ['DRAFT', 'IN_REVIEW'].includes(item.post.state)) tabs.awaiting.push(item);
    else if (item.post && item.post.state !== 'CANCELED') tabs.approved.push(item);
  }
  return { tabs, olderSkipped };
}

/** Stops (or restarts) every RSS rule in the workspace: no feed checks and no AI credits are used while stopped. */
export async function setAllRssEnabled(userId: string, slug: string, enabled: boolean) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot change RSS rules.');
    const where = { workspaceId: membership.workspaceId };
    if (!enabled) return (await tx.rssRule.updateMany({ where, data: { enabled: false } })).count;
    const plain = await tx.rssRule.updateMany({ where: { ...where, publishAfterApproval: false }, data: { enabled: true, nextRunAt: new Date() } });
    const scheduled = await tx.rssRule.updateMany({
      where: { ...where, publishAfterApproval: true }, data: { enabled: true, nextRunAt: new Date(), authorizedById: userId },
    });
    return plain.count + scheduled.count;
  });
}
