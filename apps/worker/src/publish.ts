import { createHash } from 'node:crypto';
import { getProvider, prisma, readImage, validateProviderPost, AssetStorageError, ProviderConfigurationError, type PublishResult } from '@cadencedesk/data';
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

export async function publishDestination(id: string): Promise<number | null> {
  const now = new Date();
  const claim = await prisma.$transaction(async (tx) => {
    const changed = await tx.destination.updateMany({
      where: {
        id, state: 'SCHEDULED',
        OR: [{ notBefore: null }, { notBefore: { lte: now } }],
        post: { state: 'SCHEDULED', scheduledAt: { lte: new Date() } },
      },
      data: { state: 'PUBLISHING', startedAt: new Date() },
    });
    if (!changed.count) return null;
    const destination = await tx.destination.findUniqueOrThrow({
      where: { id },
      include: { channel: true, post: { include: { workspace: true } }, _count: { select: { attempts: true } } },
    });
    const [revision, approval] = await Promise.all([
      tx.postRevision.findUnique({ where: { postId_number: { postId: destination.postId, number: destination.revision } }, include: { asset: true } }),
      tx.approval.findUnique({ where: { postId_revision: { postId: destination.postId, revision: destination.revision } } }),
    ]);
    const attempt = await tx.publishAttempt.create({
      data: { destinationId: id, number: destination._count.attempts + 1, state: 'PUBLISHING' },
    });
    return { destination, revision, approval, attempt };
  });
  if (!claim) {
    const pending = await prisma.destination.findFirst({
      where: { id, state: 'SCHEDULED' },
      select: { notBefore: true, post: { select: { scheduledAt: true } } },
    });
    if (!pending) return null;
    const due = Math.max(pending.notBefore?.getTime() ?? 0, pending.post.scheduledAt?.getTime() ?? 0);
    return due > now.getTime() ? due - now.getTime() : null;
  }
  const { destination, revision, approval, attempt } = claim;
  const valid = revision?.channelIds.includes(destination.channelId) && approval && destination.revision === destination.post.revision
    && destination.channel.workspaceId === destination.post.workspaceId;
  const nonce = createHash('sha256').update(id).digest('base64url').slice(0, 25);
  const provider = getProvider(destination.channel.provider);
  let result: PublishResult = { kind: 'failed', error: 'The approved revision or destination is unavailable.' };
  if (valid && revision && provider) {
    const asset = revision.asset;
    try {
      validateProviderPost(destination.channel.provider, revision.content, Boolean(asset));
      const image = asset ? { bytes: await readImage(asset, destination.post.workspaceId), type: asset.type } : undefined;
      result = await provider.publish(destination.post.workspace.slug, destination.channel, nonce, revision.content, image);
    } catch (error) {
      if (!(error instanceof AssetStorageError || error instanceof ProviderConfigurationError)) throw error;
      result = { kind: 'failed', error: error.message };
    }
  }
  const retryDelay = result.kind === 'retry' && attempt.number < 5 ? result.delayMs : null;
  const outcome = result.kind === 'published'
    ? { state: 'PUBLISHED' as const, externalId: result.externalId, permalink: result.permalink, error: null }
    : result.kind === 'uncertain'
      ? { state: 'UNCERTAIN' as const, error: result.error }
      : retryDelay !== null
        ? { state: 'SCHEDULED' as const, error: null, notBefore: new Date(Date.now() + retryDelay) }
        : { state: 'FAILED' as const, error: result.kind === 'retry' ? 'Provider rate limit retries exhausted.' : result.error };
  await prisma.$transaction(async (tx) => {
    const saved = await tx.destination.updateMany({
      where: { id, state: 'PUBLISHING', startedAt: destination.startedAt },
      data: outcome,
    });
    if (!saved.count) return;
    await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: { state: retryDelay !== null ? 'FAILED' : outcome.state, error: retryDelay !== null ? 'Provider rate limit.' : outcome.error, finishedAt: new Date() },
    });
  });
  return retryDelay;
}

export async function dispatchOutbox(client: Client) {
  const events = await prisma.outboxEvent.findMany({
    where: { dispatchedAt: null },
    orderBy: { dueAt: 'asc' },
    take: 50,
  });
  for (const event of events) {
    try {
      await client.workflow.start('publishAt', {
        taskQueue: 'cadencedesk',
        workflowId: `publish-${event.destinationId}`,
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        args: [event.destinationId, event.dueAt.getTime()],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    await prisma.outboxEvent.updateMany({
      where: { destinationId: event.destinationId, dispatchedAt: null },
      data: { dispatchedAt: new Date() },
    });
  }
}

export async function reconcileInterrupted() {
  const error = 'Publishing stopped before the result was saved. Check the destination before sending again.';
  await prisma.$transaction(async (tx) => {
    const abandoned = await tx.destination.updateManyAndReturn({
      where: { state: 'PUBLISHING', startedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      data: { state: 'UNCERTAIN', error },
      select: { id: true },
    });
    if (!abandoned.length) return;
    await tx.publishAttempt.updateMany({
      where: { destinationId: { in: abandoned.map(({ id }) => id) }, state: 'PUBLISHING' },
      data: { state: 'UNCERTAIN', error, finishedAt: new Date() },
    });
  });
}
