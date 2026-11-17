import { prisma } from './client';
import { canWritePosts } from './publishing';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

export class RssConfigurationError extends Error {}

function approvedFeedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search
    || !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) {
    throw new RssConfigurationError('Use an approved HTTPS feed URL.');
  }
  return url;
}

export function allowedFeedUrl(value: string) {
  try {
    const url = approvedFeedUrl(value);
    const allowed = (process.env.RSS_ALLOWED_FEEDS ?? '').split(',').some((entry) => {
      try { return approvedFeedUrl(entry.trim()).href === url.href; } catch { return false; }
    });
    if (allowed) return url;
  } catch {
    // Report a generic error for invalid or unapproved URLs.
  }
  throw new RssConfigurationError('Ask the workspace operator to allow this exact HTTPS feed URL.');
}

export function rssConfigured() {
  return Boolean(process.env.RSS_ALLOWED_FEEDS?.trim());
}

export async function addRssRule(userId: string, slug: string, name: string, value: string) {
  const url = allowedFeedUrl(value);
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot add RSS rules.');
    const { workspaceId } = membership;
    await tx.rssRule.upsert({
      where: { workspaceId_sourceUrl: { workspaceId, sourceUrl: url.href } },
      create: { workspaceId, sourceUrl: url.href, name }, update: { name },
    });
  });
}

export async function setRssEnabled(userId: string, slug: string, id: string, enabled: boolean) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot change RSS rules.');
    const result = await tx.rssRule.updateMany({
      where: { id, workspaceId: membership.workspaceId },
      data: enabled ? { enabled, nextRunAt: new Date() } : { enabled },
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
    include: { runs: { orderBy: { createdAt: 'desc' }, take: 5,
      select: { id: true, state: true, imported: true, error: true, createdAt: true },
    } },
  });
}
