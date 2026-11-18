import { fetchFeed, parseFeed, prisma, ProviderConfigurationError, RssConfigurationError, validateProviderPost } from '@cadencedesk/data';
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

export async function importRssRun(id: string) {
  const run = await prisma.rssRun.findUnique({ where: { id }, include: { rule: true } });
  if (run?.state !== 'QUEUED') return;
  if (!run.rule.enabled) {
    await prisma.rssRun.updateMany({ where: { id, state: 'QUEUED' }, data: { state: 'SKIPPED' } });
    return;
  }
  let entries;
  try {
    entries = parseFeed(await fetchFeed(run.rule.sourceUrl));
  } catch (error) {
    await prisma.rssRun.updateMany({
      where: { id, state: 'QUEUED' },
      data: { state: 'FAILED', error: error instanceof RssConfigurationError ? error.message : 'The RSS feed could not be fetched.' },
    });
    return;
  }
  await recordFeedItems(id, entries);
}

export async function recordFeedItems(id: string, entries: { sourceKey: string; content: string }[]) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.rssRun.findUnique({ where: { id }, include: { rule: true } });
    if (run?.state !== 'QUEUED') return 0;
    const updated = await tx.rssRun.updateMany({
      where: { id, state: 'QUEUED' },
      data: { state: run.rule.enabled ? 'COMPLETED' : 'SKIPPED' },
    });
    if (!updated.count || !run.rule.enabled) return 0;
    const { workspaceId, channelIds, publishAfterApproval } = run.rule;
    const channels = publishAfterApproval ? await tx.channel.findMany({
      where: { workspaceId, id: { in: channelIds } }, select: { provider: true },
    }) : [];
    let imported = 0;
    for (const { sourceKey, content } of entries) {
      const item = await tx.feedImport.createMany({
        data: [{ ruleId: run.ruleId, sourceKey, scheduleState: publishAfterApproval ? 'WAITING_REVIEW' : 'OFF' }], skipDuplicates: true,
      });
      if (!item.count) continue;
      let readyToReview = Boolean(channels.length && channels.length === channelIds.length);
      if (readyToReview) {
        try {
          for (const channel of channels) validateProviderPost(channel.provider, content);
        } catch (error) {
          if (!(error instanceof ProviderConfigurationError)) throw error;
          readyToReview = false;
        }
      }
      const post = await tx.post.create({
        data: {
          workspaceId, state: readyToReview ? 'IN_REVIEW' : 'DRAFT',
          revisions: { create: { number: 1, content, channelIds: readyToReview ? channelIds : [] } },
        },
      });
      await tx.feedImport.update({
        where: { ruleId_sourceKey: { ruleId: run.ruleId, sourceKey } }, data: { postId: post.id },
      });
      imported++;
    }
    await tx.rssRun.update({ where: { id }, data: { imported } });
    return imported;
  }, { timeout: 20_000 });
}

export async function queueDueRssRules() {
  const now = new Date();
  const interval = 15 * 60_000;
  const bucket = new Date(Math.floor(now.getTime() / interval) * interval);
  const due = await prisma.rssRule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' }, take: 30, select: { id: true },
  });
  for (const { id } of due) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.rssRule.updateMany({
        where: { id, enabled: true, nextRunAt: { lte: now } },
        data: { nextRunAt: new Date(bucket.getTime() + interval) },
      });
      if (moved.count) await tx.rssRun.createMany({ data: [{ ruleId: id, bucket }], skipDuplicates: true });
    });
  }
}

export async function dispatchRssRuns(client: Client) {
  const runs = await prisma.rssRun.findMany({
    where: { dispatchedAt: null, state: 'QUEUED' },
    orderBy: { createdAt: 'asc' }, take: 30, select: { id: true },
  });
  for (const { id } of runs) {
    try {
      await client.workflow.start('importRssFeed', {
        taskQueue: 'cadencedesk', workflowId: 'rss-' + id,
        workflowIdReusePolicy: 'REJECT_DUPLICATE', args: [id],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    await prisma.rssRun.updateMany({ where: { id, dispatchedAt: null }, data: { dispatchedAt: new Date() } });
  }
}
