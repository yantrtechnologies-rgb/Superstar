import { createHash } from 'node:crypto';
import {
  createMetaAssetUrl, enqueuePublishedWebhooks, getProvider, prisma, readImage, readVideo, revisionFormats, revisionMediaIds, revisionOverrides,
  revisionThread, validateProviderPost, AssetStorageError, ProviderConfigurationError, type PublishingImage, type PublishResult,
} from '@cadencedesk/data';
import type { Prisma } from '@cadencedesk/data';
import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';

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
      include: { channel: true, parent: true, post: { include: { workspace: true } }, _count: { select: { attempts: true } } },
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
  const thread = revision ? revisionThread(revision) : [];
  if (valid && revision && provider) {
    const parent = destination.parent;
    const workspaceId = destination.post.workspaceId;
    try {
      if (!destination.parentId) {
        const text = revisionOverrides(revision.overrides)[destination.channelId] ?? revision.content;
        const ids = revisionMediaIds(revision).slice(0, provider.maxImages ?? 1);
        const assets = ids.length ? await prisma.asset.findMany({ where: { id: { in: ids }, workspaceId } }) : [];
        const ordered = ids.map((assetId) => assets.find(({ id: found }) => found === assetId)).filter((item) => item !== undefined);
        if (ordered.length !== ids.length) throw new AssetStorageError('An attached media file is no longer available.');
        validateProviderPost(destination.channel.provider, text, ordered[0]?.type);
        const images: PublishingImage[] = [];
        // Instagram downloads media from a signed URL, and reminder channels only link to it, so neither needs the bytes.
        const byUrl = ['instagram', 'instagram-direct'].includes(destination.channel.provider);
        const skipBytes = byUrl || destination.channel.provider === 'reminder';
        for (const asset of ordered) {
          images.push({
            bytes: skipBytes ? new Uint8Array(0) : asset.type === 'video/mp4' ? await readVideo(asset, workspaceId) : await readImage(asset, workspaceId),
            type: asset.type,
            url: byUrl ? createMetaAssetUrl(asset.id, workspaceId) : undefined,
          });
        }
        const format = revisionFormats(revision.formats)[destination.channelId] ?? 'post';
        result = await provider.publish(destination.post.workspace.slug, destination.channel, nonce, text, images[0], images, { format });
      } else {
        const index = Math.max(1, destination.threadIndex);
        const item = thread[index - 1];
        if (parent?.state === 'PUBLISHED' && parent.externalId && parent.postId === destination.postId
          && parent.channelId === destination.channelId && parent.revision === destination.revision && item && provider.reply) {
          if (item.content.length > provider.textLimit) throw new ProviderConfigurationError(`${provider.name} allows up to ${provider.textLimit} characters per thread item.`);
          result = await provider.reply(destination.post.workspace.slug, destination.channel, nonce, item.content, parent.externalId);
        } else {
          result = { kind: 'failed', error: 'The approved thread item or its parent publication is unavailable.' };
        }
      }
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
    if (outcome.state === 'PUBLISHED') {
      // Thread items publish one after another, each as a reply to the previous item after its own delay.
      const nextIndex = destination.parentId ? Math.max(1, destination.threadIndex) + 1 : 1;
      const next = thread[nextIndex - 1];
      if (next && provider?.reply) {
        const dueAt = new Date(Date.now() + Math.max(next.delayMinutes, 0) * 60_000);
        await tx.destination.create({
          data: {
            postId: destination.postId, channelId: destination.channelId, revision: destination.revision,
            parentId: id, threadIndex: nextIndex, notBefore: dueAt, outbox: { create: { dueAt } },
          },
        });
      }
    }
    if (outcome.state === 'PUBLISHED' && !destination.parentId) {
      await enqueuePublishedWebhooks(tx, {
        workspaceId: destination.post.workspaceId, postId: destination.postId, destinationId: id,
        channelId: destination.channelId, provider: destination.channel.provider,
        externalId: outcome.externalId, permalink: outcome.permalink,
      });
    }
    await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: { state: retryDelay !== null ? 'FAILED' : outcome.state, error: retryDelay !== null ? 'Provider rate limit.' : outcome.error, finishedAt: new Date() },
    });
  });
  // The next occurrence of a repeating post is created after the result is saved, in its own transaction: when
  // several channels publish at once, only one creates it, and a collision can never undo a confirmed publication.
  if (outcome.state === 'PUBLISHED' && !destination.parentId) {
    try {
      await prisma.$transaction((tx) => scheduleRepeat(tx, destination.postId));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'P2002') console.error(JSON.stringify({ event: 'publishing.repeat_failed', postId: destination.postId, code }));
    }
  }
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
        workflowId: `publish-${event.destinationId}-${event.dueAt.getTime()}`,
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

/**
 * Safety net for the scheduler: a post still waiting to go out must have a running scheduler workflow. If it is
 * missing (scheduler data lost or restored from a backup) or ended early, the post is queued again; publishing
 * itself checks the database state, so a post can never go out twice this way.
 */
export async function recoverLostWorkflows(client: Client) {
  const events = await prisma.outboxEvent.findMany({
    where: { dispatchedAt: { not: null, lt: new Date(Date.now() - 5 * 60_000) }, destination: { state: 'SCHEDULED' } },
    orderBy: { dueAt: 'asc' }, take: 200, select: { destinationId: true, dueAt: true },
  });
  let recovered = 0;
  for (const event of events) {
    const workflowId = `publish-${event.destinationId}-${event.dueAt.getTime()}`;
    let closed = false;
    try {
      const described = await client.workflow.getHandle(workflowId).describe();
      if (described.status.name === 'RUNNING') continue;
      closed = true;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
    // A closed workflow keeps its id, so the re-queued one needs a new id (a 1 ms later due time).
    await prisma.outboxEvent.updateMany({
      where: { destinationId: event.destinationId, dueAt: event.dueAt, dispatchedAt: { not: null } },
      data: { dispatchedAt: null, dueAt: closed ? new Date(event.dueAt.getTime() + 1) : event.dueAt },
    });
    recovered++;
  }
  return recovered;
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

/**
 * Creates the next occurrence of a repeating post once it publishes. The copy keeps the approved
 * revision (content was already approved), its channels and tags, and is due repeatEveryDays later.
 * repeatSourceId is unique, so each post spawns at most one successor.
 */
async function scheduleRepeat(tx: Prisma.TransactionClient, postId: string) {
  const post = await tx.post.findUnique({
    where: { id: postId },
    include: { revisions: { orderBy: { number: 'desc' }, take: 1 }, tags: true },
  });
  const latest = post?.revisions[0];
  if (!post?.repeatEveryDays || !post.scheduledAt || !latest || latest.number !== post.revision) return;
  if (await tx.post.findUnique({ where: { repeatSourceId: post.id }, select: { id: true } })) return;
  const step = post.repeatEveryDays * 86_400_000;
  let due = post.scheduledAt.getTime() + step;
  while (due < Date.now() + 60_000) due += step;
  const dueAt = new Date(due);
  const copy = await tx.post.create({ data: {
    workspaceId: post.workspaceId, state: 'SCHEDULED', scheduledAt: dueAt, repeatEveryDays: post.repeatEveryDays, repeatSourceId: post.id,
    revisions: { create: {
      number: 1, content: latest.content, overrides: latest.overrides ?? {}, formats: latest.formats ?? {}, thread: latest.thread ?? [], mediaIds: latest.mediaIds,
      assetId: latest.assetId, channelIds: latest.channelIds, followUpText: latest.followUpText, followUpDelayMinutes: latest.followUpDelayMinutes,
    } },
    tags: { create: post.tags.map(({ tagId }) => ({ tagId })) },
  } });
  await tx.approval.create({ data: { postId: copy.id, revision: 1 } });
  for (const channelId of latest.channelIds) {
    await tx.destination.create({ data: { postId: copy.id, channelId, revision: 1, outbox: { create: { dueAt } } } });
  }
  await tx.auditEvent.create({ data: { workspaceId: post.workspaceId, subjectId: copy.id, action: 'post.repeat_scheduled' } });
}
