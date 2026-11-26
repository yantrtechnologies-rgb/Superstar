import { assertWithinChannelPlan } from './plans';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { uploadPostAsset } from './assets';
import { prisma } from './client';
import { findNextPostingSlot } from './next-slot';
import { postFormats, ProviderConfigurationError, type PostFormat } from './provider-contract';
import { getProvider, providers as providersForComposer } from './providers';
import { canApprovePosts, canWritePosts } from './publishing';
import { WorkspaceAccessError } from './workspaces';

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };
const uuid = z.uuid();

export const threadItemSchema = z.object({
  content: z.string().trim().min(1).max(4096),
  delayMinutes: z.number().int().min(0).max(10_080),
});
export type ThreadItem = z.infer<typeof threadItemSchema>;

export const composerInput = z.object({
  postId: uuid.optional(),
  revision: z.number().int().positive().optional(),
  channelIds: z.array(uuid).max(20),
  content: z.string().max(10_000),
  overrides: z.record(uuid, z.string().max(10_000)).default({}),
  formats: z.record(uuid, z.enum(postFormats)).default({}),
  thread: z.array(threadItemSchema).max(25).default([]),
  mediaIds: z.array(uuid).max(10).default([]),
  tagIds: z.array(uuid).max(20).default([]),
  repeatEveryDays: z.number().int().min(1).max(365).nullable().default(null),
  intent: z.enum(['draft', 'review', 'schedule', 'next', 'now']),
  scheduledAt: z.iso.datetime().optional(),
});
export type ComposerInput = z.input<typeof composerInput>;

/** Reads the structured thread of a revision, falling back to the legacy single follow-up. */
export function revisionThread(revision: { thread: Prisma.JsonValue; followUpText: string | null; followUpDelayMinutes: number | null }): ThreadItem[] {
  const parsed = z.array(threadItemSchema).safeParse(revision.thread);
  if (parsed.success && parsed.data.length) return parsed.data;
  return revision.followUpText ? [{ content: revision.followUpText, delayMinutes: revision.followUpDelayMinutes ?? 1 }] : [];
}

export function revisionOverrides(value: Prisma.JsonValue): Record<string, string> {
  return z.record(z.string(), z.string()).safeParse(value).data ?? {};
}

/** Per-channel Reel/Story choices of a revision; channels not listed get a normal post. */
export function revisionFormats(value: Prisma.JsonValue): Record<string, PostFormat> {
  return z.record(z.string(), z.enum(postFormats)).safeParse(value).data ?? {};
}

/** Ordered media for a revision; legacy revisions only have assetId. */
export function revisionMediaIds(revision: { mediaIds: string[]; assetId: string | null }) {
  return revision.mediaIds.length ? revision.mediaIds : revision.assetId ? [revision.assetId] : [];
}

async function member(tx: Prisma.TransactionClient, userId: string, slug: string) {
  const found = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!found) throw new WorkspaceAccessError('Workspace is unavailable.');
  return found;
}

/** Per-channel problems for a draft; empty when every selected channel can publish it. */
export async function checkComposer(
  tx: Prisma.TransactionClient, workspaceId: string,
  draft: { channelIds: string[]; content: string; overrides: Record<string, string>; thread: ThreadItem[]; mediaIds: string[]; formats?: Record<string, PostFormat> },
) {
  const [channels, media] = await Promise.all([
    tx.channel.findMany({ where: { workspaceId, id: { in: draft.channelIds } }, select: { id: true, name: true, provider: true } }),
    tx.asset.findMany({ where: { workspaceId, id: { in: draft.mediaIds }, archivedAt: null }, select: { id: true, type: true } }),
  ]);
  const problems: string[] = [];
  if (channels.length !== new Set(draft.channelIds).size) problems.push('One or more selected channels are unavailable.');
  if (media.length !== new Set(draft.mediaIds).size) problems.push('One or more selected media files are unavailable.');
  const types = draft.mediaIds.map((id) => media.find((item) => item.id === id)?.type).filter(Boolean) as string[];
  for (const channel of channels) {
    const provider = getProvider(channel.provider);
    if (!provider) { problems.push(`${channel.name}: this connector is unavailable.`); continue; }
    const text = (draft.overrides[channel.id] ?? draft.content).trim();
    const first = types[0];
    const hasImage = first?.startsWith('image/') ?? false;
    const hasVideo = first?.startsWith('video/') ?? false;
    const format = draft.formats?.[channel.id] ?? 'post';
    if (format !== 'post' && !provider.formats?.includes(format)) problems.push(`${channel.name}: ${provider.name} can't publish a ${format}.`);
    if (format === 'reel' && !hasVideo) problems.push(`${channel.name}: a Reel needs an MP4 video as the first media file.`);
    if (format === 'story' && !hasImage && !hasVideo) problems.push(`${channel.name}: a Story needs a photo or video.`);
    if (provider.requiresImage && !hasImage && !(provider.acceptsVideo && hasVideo)) {
      problems.push(`${channel.name}: ${provider.name} needs an image${provider.acceptsVideo ? ' or video' : ''}.`);
    }
    if (provider.requiresVideo && !hasVideo) problems.push(`${channel.name}: ${provider.name} needs an MP4 video.`);
    if (hasVideo && !provider.acceptsVideo) problems.push(`${channel.name}: ${provider.name} does not accept video here.`);
    const limit = hasImage || hasVideo ? provider.imageCaptionLimit : provider.textLimit;
    if (limit === null) problems.push(`${channel.name}: ${provider.name} supports text-only posts in this connector.`);
    else if (!text) problems.push(`${channel.name}: the post text is empty.`);
    else if (text.length > limit && !provider.splitsLongText) problems.push(`${channel.name}: ${text.length}/${limit} characters.`);
    for (const [index, item] of draft.thread.entries()) {
      if (provider.reply && item.content.length > provider.textLimit) {
        problems.push(`${channel.name}: thread item ${index + 1} is ${item.content.length}/${provider.textLimit} characters.`);
      }
    }
  }
  return problems;
}

/**
 * Saves composer content as a new draft revision, then optionally submits it, approves it and schedules it.
 * Approve-and-schedule needs approver rights; editors stop at "in review".
 */
export async function saveComposerPost(userId: string, slug: string, raw: ComposerInput) {
  const input = composerInput.parse(raw);
  const channelIds = [...new Set(input.channelIds)].sort();
  const overrides = Object.fromEntries(Object.entries(input.overrides)
    .filter(([id, text]) => channelIds.includes(id) && text.trim() && text !== input.content));
  const formats = Object.fromEntries(Object.entries(input.formats).filter(([id, format]) => channelIds.includes(id) && format !== 'post'));
  if (!input.content.trim() && !channelIds.some((id) => overrides[id])) throw new WorkspaceAccessError('Write the post text first.');
  if (input.intent !== 'draft' && !channelIds.length) throw new WorkspaceAccessError('Choose at least one channel.');

  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await member(tx, userId, slug);
    if (!canWritePosts(role)) throw new WorkspaceAccessError('You cannot edit posts.');
    if (input.intent !== 'draft') await assertWithinChannelPlan(tx, workspaceId);
    const tags = input.tagIds.length ? await tx.tag.count({ where: { workspaceId, id: { in: input.tagIds } } }) : 0;
    if (tags !== new Set(input.tagIds).size) throw new WorkspaceAccessError('A selected tag is unavailable.');
    const fields = {
      content: input.content, overrides, formats, thread: input.thread, mediaIds: input.mediaIds, assetId: input.mediaIds[0] ?? null,
      channelIds, followUpText: null, followUpDelayMinutes: null,
    };

    let postId = input.postId;
    let revision: number;
    if (!postId) {
      const created = await tx.post.create({
        data: { workspaceId, repeatEveryDays: input.repeatEveryDays, revisions: { create: { number: 1, ...fields } } },
      });
      postId = created.id;
      revision = 1;
    } else {
      if (input.revision === undefined) throw new WorkspaceAccessError('Reload the post and try again.');
      const updated = await tx.post.updateMany({
        where: { id: postId, workspaceId, revision: input.revision, state: { in: ['DRAFT', 'IN_REVIEW', 'APPROVED'] } },
        data: { state: 'DRAFT', revision: { increment: 1 }, repeatEveryDays: input.repeatEveryDays },
      });
      if (!updated.count) throw new WorkspaceAccessError('This post changed, is already scheduled, or is unavailable.');
      revision = input.revision + 1;
      await tx.postRevision.create({ data: { postId, number: revision, ...fields } });
    }
    await tx.postTag.deleteMany({ where: { postId } });
    if (input.tagIds.length) await tx.postTag.createMany({ data: [...new Set(input.tagIds)].map((tagId) => ({ postId: postId!, tagId })) });

    if (input.intent === 'draft') return { postId, revision, state: 'DRAFT' as const };

    const problems = await checkComposer(tx, workspaceId, { channelIds, content: input.content, overrides, formats, thread: input.thread, mediaIds: input.mediaIds });
    if (problems.length) throw new ProviderConfigurationError(problems.join(' '));
    await tx.post.update({ where: { id: postId }, data: { state: 'IN_REVIEW' } });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: postId, action: 'post.submitted' } });
    if (input.intent === 'review' || !canApprovePosts(role)) return { postId, revision, state: 'IN_REVIEW' as const };

    await tx.post.update({ where: { id: postId }, data: { state: 'APPROVED' } });
    await tx.approval.create({ data: { postId, revision, reviewerId: userId } });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: postId, action: 'post.approved' } });

    let when: Date;
    if (input.intent === 'now') when = new Date();
    else if (input.intent === 'next') when = await findNextPostingSlot(tx, workspaceId, channelIds);
    else {
      when = new Date(input.scheduledAt ?? '');
      if (!Number.isFinite(when.getTime()) || when.getTime() < Date.now() - 60_000) throw new WorkspaceAccessError('Choose a future date and time.');
    }
    await tx.post.update({ where: { id: postId }, data: { state: 'SCHEDULED', scheduledAt: when } });
    for (const channelId of channelIds) {
      await tx.destination.create({ data: { postId, channelId, revision, outbox: { create: { dueAt: when } } } });
    }
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: postId, action: 'post.scheduled' } });
    return { postId, revision, state: 'SCHEDULED' as const, scheduledAt: when };
  }, serializable);
}

/** Loads one post with everything the composer needs. */
export async function loadComposerPost(userId: string, slug: string, postId: string) {
  const post = await prisma.post.findFirst({
    where: { id: postId, workspace: { slug, memberships: { some: { userId } } } },
    include: { revisions: { orderBy: { number: 'desc' }, take: 1 }, tags: { select: { tagId: true } } },
  });
  const latest = post?.revisions[0];
  if (!post || !latest) return null;
  return {
    id: post.id, revision: post.revision, state: post.state, scheduledAt: post.scheduledAt, repeatEveryDays: post.repeatEveryDays,
    content: latest.content, channelIds: latest.channelIds, overrides: revisionOverrides(latest.overrides),
    formats: revisionFormats(latest.formats), thread: revisionThread(latest), mediaIds: revisionMediaIds(latest), tagIds: post.tags.map(({ tagId }) => tagId),
  };
}

/** Moves a scheduled post to a new time. Allowed only before any destination has started. */
export async function reschedulePost(userId: string, slug: string, postId: string, at: Date) {
  if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() - 60_000) throw new WorkspaceAccessError('Choose a future date and time.');
  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await member(tx, userId, slug);
    if (!canWritePosts(role)) throw new WorkspaceAccessError('You cannot reschedule posts.');
    const post = await tx.post.findFirst({ where: { id: postId, workspaceId, state: 'SCHEDULED' }, include: { destinations: true } });
    const roots = post?.destinations.filter(({ parentId }) => !parentId) ?? [];
    if (!post || !roots.length || roots.some(({ state }) => state !== 'SCHEDULED' && state !== 'CANCELED')) {
      throw new WorkspaceAccessError('Only posts that have not started publishing can be moved.');
    }
    await tx.post.update({ where: { id: postId }, data: { scheduledAt: at } });
    const pending = roots.filter(({ state }) => state === 'SCHEDULED').map(({ id }) => id);
    // A new due time gets a new timed job; the old job wakes, finds the new time and stands down.
    await tx.outboxEvent.updateMany({ where: { destinationId: { in: pending } }, data: { dueAt: at, dispatchedAt: null } });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: postId, action: 'post.rescheduled' } });
  }, serializable);
}

/** Copies a post's latest content into a new draft. */
export async function duplicatePost(userId: string, slug: string, postId: string) {
  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await member(tx, userId, slug);
    if (!canWritePosts(role)) throw new WorkspaceAccessError('You cannot create posts.');
    const post = await tx.post.findFirst({
      where: { id: postId, workspaceId }, include: { revisions: { orderBy: { number: 'desc' }, take: 1 }, tags: true },
    });
    const latest = post?.revisions[0];
    if (!post || !latest) throw new WorkspaceAccessError('Post unavailable.');
    const copy = await tx.post.create({ data: {
      workspaceId, repeatEveryDays: post.repeatEveryDays,
      revisions: { create: {
        number: 1, content: latest.content, overrides: latest.overrides ?? {}, formats: latest.formats ?? {}, thread: latest.thread ?? [], mediaIds: latest.mediaIds,
        assetId: latest.assetId, channelIds: latest.channelIds, followUpText: latest.followUpText, followUpDelayMinutes: latest.followUpDelayMinutes,
      } },
      tags: { create: post.tags.map(({ tagId }) => ({ tagId })) },
    } });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: copy.id, action: 'post.duplicated' } });
    return copy;
  }, serializable);
}

/** Cancels one channel's pending destination (and its thread) while the rest of the post goes ahead. */
export async function cancelDestination(userId: string, slug: string, destinationId: string) {
  return prisma.$transaction(async (tx) => {
    const { workspaceId, role } = await member(tx, userId, slug);
    if (!canWritePosts(role)) throw new WorkspaceAccessError('You cannot change posts.');
    const target = await tx.destination.findFirst({ where: { id: destinationId, parentId: null, state: 'SCHEDULED', post: { workspaceId } } });
    if (!target) throw new WorkspaceAccessError('That channel has already published or is unavailable.');
    await tx.destination.update({ where: { id: target.id }, data: { state: 'CANCELED' } });
    const remaining = await tx.destination.count({ where: { postId: target.postId, state: { not: 'CANCELED' } } });
    if (!remaining) await tx.post.update({ where: { id: target.postId }, data: { state: 'CANCELED' } });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: target.postId, action: 'post.destination_canceled' } });
  }, serializable);
}

// ---------- Tags, signatures, sets ----------

const tagColors = ['#7b4dff', '#d33cf2', '#3ad19c', '#f5b544', '#ff6b7d', '#38bdf8', '#a3e635', '#f97316'];
const tagFields = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });

async function manager(userId: string, slug: string) {
  const found = await member(prisma, userId, slug);
  if (!canWritePosts(found.role)) throw new WorkspaceAccessError('You cannot change content settings.');
  return found.workspaceId;
}

export async function listContentSettings(userId: string, slug: string) {
  const workspace = await prisma.workspace.findFirst({
    where: { slug, memberships: { some: { userId } } },
    select: {
      tags: { orderBy: { name: 'asc' } },
      signatures: { orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] },
      postSets: { orderBy: { name: 'asc' } },
    },
  });
  return workspace ?? { tags: [], signatures: [], postSets: [] };
}

export async function saveTag(userId: string, slug: string, raw: { id?: string; name: string; color?: string }) {
  const workspaceId = await manager(userId, slug);
  const fields = tagFields.parse(raw);
  if (raw.id) {
    const changed = await prisma.tag.updateMany({ where: { id: raw.id, workspaceId }, data: fields });
    if (!changed.count) throw new WorkspaceAccessError('Tag unavailable.');
    return;
  }
  const count = await prisma.tag.count({ where: { workspaceId } });
  await prisma.tag.create({ data: { workspaceId, name: fields.name, color: fields.color ?? tagColors[count % tagColors.length]! } });
}

export async function deleteTag(userId: string, slug: string, id: string) {
  const workspaceId = await manager(userId, slug);
  await prisma.tag.deleteMany({ where: { id, workspaceId } });
}

const signatureFields = z.object({ name: z.string().trim().min(1).max(60), content: z.string().trim().min(1).max(2000), isDefault: z.boolean() });

export async function saveSignature(userId: string, slug: string, raw: { id?: string; name: string; content: string; isDefault: boolean }) {
  const workspaceId = await manager(userId, slug);
  const fields = signatureFields.parse(raw);
  await prisma.$transaction(async (tx) => {
    if (fields.isDefault) await tx.signature.updateMany({ where: { workspaceId }, data: { isDefault: false } });
    if (raw.id) {
      const changed = await tx.signature.updateMany({ where: { id: raw.id, workspaceId }, data: fields });
      if (!changed.count) throw new WorkspaceAccessError('Signature unavailable.');
    } else await tx.signature.create({ data: { workspaceId, ...fields } });
  });
}

export async function deleteSignature(userId: string, slug: string, id: string) {
  const workspaceId = await manager(userId, slug);
  await prisma.signature.deleteMany({ where: { id, workspaceId } });
}

export const postSetData = composerInput.pick({ channelIds: true, content: true, overrides: true, thread: true, tagIds: true, repeatEveryDays: true });

export async function savePostSet(userId: string, slug: string, name: string, data: z.input<typeof postSetData>) {
  const workspaceId = await manager(userId, slug);
  const clean = postSetData.parse(data);
  const title = z.string().trim().min(1).max(60).parse(name);
  await prisma.postSet.upsert({
    where: { workspaceId_name: { workspaceId, name: title } },
    create: { workspaceId, name: title, data: clean }, update: { data: clean },
  });
}

export async function deletePostSet(userId: string, slug: string, id: string) {
  const workspaceId = await manager(userId, slug);
  await prisma.postSet.deleteMany({ where: { id, workspaceId } });
}

// ---------- Media library ----------

export async function listMedia(userId: string, slug: string, search?: string) {
  return prisma.asset.findMany({
    where: {
      workspace: { slug, memberships: { some: { userId } } }, archivedAt: null,
      ...(search ? { OR: [{ label: { contains: search, mode: 'insensitive' } }, { alt: { contains: search, mode: 'insensitive' } }] } : {}),
    },
    orderBy: { createdAt: 'desc' }, take: 200,
    select: { id: true, type: true, size: true, label: true, alt: true, createdAt: true },
  });
}

export async function uploadMedia(userId: string, slug: string, file: { bytes: Uint8Array<ArrayBuffer>; type: string; name: string }) {
  const workspaceId = await manager(userId, slug);
  const stored = await uploadPostAsset(workspaceId, file.bytes, file.type);
  return prisma.asset.create({ data: { workspaceId, ...stored, label: file.name.slice(0, 120) || null } });
}

export async function updateMedia(userId: string, slug: string, id: string, fields: { alt?: string | null; label?: string | null }) {
  const workspaceId = await manager(userId, slug);
  const data = z.object({ alt: z.string().trim().max(1000).nullable().optional(), label: z.string().trim().max(120).nullable().optional() }).parse(fields);
  const changed = await prisma.asset.updateMany({ where: { id, workspaceId }, data });
  if (!changed.count) throw new WorkspaceAccessError('Media unavailable.');
}

/** Hides media from the library. Files used by posts stay stored so history and scheduled posts keep working. */
export async function archiveMedia(userId: string, slug: string, ids: string[]) {
  const workspaceId = await manager(userId, slug);
  await prisma.asset.updateMany({ where: { id: { in: ids }, workspaceId }, data: { archivedAt: new Date() } });
}

/** Next free posting slot for the composer's "Use next slot" hint. */
export async function suggestSlot(userId: string, slug: string, channelIds: string[]) {
  const { workspaceId } = await member(prisma, userId, slug);
  return findNextPostingSlot(prisma, workspaceId, channelIds);
}

/** A media file in a workspace the user belongs to (for thumbnails, previews and the library). */
export function mediaFile(userId: string, slug: string, id: string) {
  return prisma.asset.findFirst({ where: { id, workspace: { slug, memberships: { some: { userId } } } } });
}

/** Provider capabilities the composer shows (limits, media and thread support). */
export function composerProviders() {
  return Object.fromEntries(Object.entries(providersForComposer).map(([id, p]) => [id, {
    name: p.name, textLimit: p.textLimit, imageCaptionLimit: p.imageCaptionLimit, maxImages: p.maxImages ?? 1, splitsLongText: Boolean(p.splitsLongText),
    formats: [...(p.formats ?? [])], thread: Boolean(p.reply), requiresImage: Boolean(p.requiresImage), requiresVideo: Boolean(p.requiresVideo), acceptsVideo: Boolean(p.acceptsVideo),
  }]));
}
