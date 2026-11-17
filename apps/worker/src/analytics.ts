import { prisma, telegramMemberCount } from '@cadencedesk/data';
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

export async function collectChannelMetric(id: string) {
  const job = await prisma.metricJob.findUnique({
    where: { id }, include: { channel: { include: { workspace: true } } },
  });
  if (job?.state !== 'QUEUED') return;
  const { channel } = job;
  const count = channel.provider === 'telegram'
    ? await telegramMemberCount(channel.workspace.slug, channel.externalId)
    : null;
  await prisma.$transaction(async (tx) => {
    const changed = await tx.metricJob.updateMany({
      where: { id, state: 'QUEUED' },
      data: count === null
        ? { state: 'UNAVAILABLE', error: 'Telegram member count could not be imported. Check the bot and destination access.' }
        : { state: 'COLLECTED', error: null },
    });
    if (changed.count && count !== null) await tx.metricsSnapshot.create({ data: { jobId: id, count } });
  });
}

export async function dispatchAnalytics(client: Client) {
  const jobs = await prisma.metricJob.findMany({ where: { dispatchedAt: null }, orderBy: { bucket: 'asc' }, take: 30 });
  for (const job of jobs) {
    try {
      await client.workflow.start('refreshChannelMetric', {
        workflowId: `metric-${job.id}`, taskQueue: 'cadencedesk',
        workflowIdReusePolicy: 'REJECT_DUPLICATE', args: [job.id],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    await prisma.metricJob.updateMany({
      where: { id: job.id, dispatchedAt: null }, data: { dispatchedAt: new Date() },
    });
  }
}
