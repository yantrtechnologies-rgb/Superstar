import { prisma } from './client';
import { canWritePosts } from './publishing';
import { WorkspaceAccessError } from './workspaces';

export async function queueChannelMetric(userId: string, slug: string, channelId: string) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canWritePosts(membership.role)) throw new WorkspaceAccessError('Analytics refresh unavailable.');
    const channel = await tx.channel.findFirst({ where: { id: channelId, workspaceId: membership.workspaceId, provider: 'telegram' } });
    if (!channel) throw new WorkspaceAccessError('This channel has no supported metrics.');
    const interval = 5 * 60_000;
    const bucket = new Date(Math.floor(Date.now() / interval) * interval);
    await tx.metricJob.createMany({ data: [{ channelId, bucket }], skipDuplicates: true });
    return tx.metricJob.findUniqueOrThrow({ where: { channelId_bucket: { channelId, bucket } } });
  });
}

export function workspaceMetrics(userId: string, slug: string, start: Date) {
  return prisma.channel.findMany({
    where: { workspace: { slug, memberships: { some: { userId } } } },
    select: {
      id: true, name: true, provider: true,
      metricJobs: {
        orderBy: { bucket: 'desc' }, take: 1,
        select: { state: true, error: true, bucket: true },
      },
    },
    orderBy: { name: 'asc' },
  }).then(async (channels) => {
    const snapshots = await prisma.metricsSnapshot.findMany({
      where: {
        observedAt: { gte: start },
        job: { channel: { workspace: { slug, memberships: { some: { userId } } } } },
      },
      orderBy: { observedAt: 'desc' },
      take: 250,
      select: { id: true, count: true, observedAt: true, job: { select: { channelId: true } } },
    });
    return channels.map((channel) => ({
      ...channel, snapshots: snapshots.filter(({ job }) => job.channelId === channel.id),
    }));
  });
}
