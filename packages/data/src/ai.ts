import { randomUUID } from 'node:crypto';
import { type AiKind, type Prisma } from '@prisma/client';
import { AssetStorageError, assetStorageConfigured, readVideo, uploadVideo } from './assets';
import { prisma } from './client';
import { canWritePosts } from './publishing';
import { WorkspaceAccessError } from './workspaces';

export const aiKinds = ['TEXT', 'IMAGE'] as const;
export class AiUnavailableError extends Error {}
export class CreditBalanceError extends Error {}
export class QuoteChangedError extends Error {}

function starterCredits() {
  const value = Number(process.env.AI_STARTER_CREDITS ?? 0);
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
}

export function clippingConfigured() {
  return process.env.MEDIA_CLIPPING_ENABLED === 'true' && assetStorageConfigured();
}

export function aiQuote(kind: AiKind) {
  if (kind === 'CLIP') return clippingConfigured() ? { credits: 0, model: 'ffmpeg' } : null;
  const values = {
    TEXT: [process.env.OPENAI_TEXT_MODEL, process.env.AI_TEXT_BASE_CREDITS],
    IMAGE: [process.env.OPENAI_IMAGE_MODEL, process.env.AI_IMAGE_BASE_CREDITS],
    TRANSCRIBE: [process.env.OPENAI_TRANSCRIBE_MODEL, process.env.AI_TRANSCRIBE_BASE_CREDITS],
  };
  const [model, amount] = values[kind];
  const base = Number(amount);
  const markup = Number(process.env.AI_CREDIT_MARKUP ?? 2);
  const credits = Math.ceil(base * markup);
  if (!process.env.OPENAI_API_KEY || !model || !Number.isFinite(base) || base <= 0
    || !Number.isFinite(markup) || markup <= 0 || credits > 1_000_000) return null;
  if (kind !== 'TEXT' && !assetStorageConfigured()) return null;
  return { credits, model };
}

async function initializeAccount(tx: Prisma.TransactionClient, workspaceId: string) {
  const amount = starterCredits();
  const created = await tx.creditAccount.createMany({
    data: { workspaceId, available: amount }, skipDuplicates: true,
  });
  if (created.count && amount) {
    await tx.creditEntry.create({ data: { workspaceId, kind: 'GRANT', delta: amount, reference: 'starter:' + workspaceId } });
  }
}

type StudioJobInput = {
  kind: AiKind;
  prompt: string;
  requestId: string;
  sourceAssetId?: string;
  startSecond?: number;
  durationSeconds?: number;
};

async function queueStudioJob(userId: string, slug: string, input: StudioJobInput, confirmedCredits: number) {
  const quote = aiQuote(input.kind);
  if (!quote) throw new AiUnavailableError('Configure the studio job and credit quote.');
  if (confirmedCredits !== quote.credits) throw new QuoteChangedError('The credit quote changed. Review the new price.');
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canWritePosts(membership.role)) throw new WorkspaceAccessError('You cannot create a studio job.');
    const { workspaceId } = membership;
    if (input.sourceAssetId && !await tx.asset.findFirst({
      where: { id: input.sourceAssetId, workspaceId, type: 'video/mp4' }, select: { id: true },
    })) throw new WorkspaceAccessError('The source video is unavailable.');
    if (quote.credits) await initializeAccount(tx, workspaceId);
    const created = await tx.aiJob.createMany({
      data: { workspaceId, ...input, ...quote }, skipDuplicates: true,
    });
    const job = await tx.aiJob.findUniqueOrThrow({
      where: { workspaceId_requestId: { workspaceId, requestId: input.requestId } },
    });
    if (!created.count) {
      if (job.kind !== input.kind || job.prompt !== input.prompt || job.credits !== quote.credits || job.model !== quote.model
        || job.sourceAssetId !== (input.sourceAssetId ?? null) || job.startSecond !== (input.startSecond ?? null)
        || job.durationSeconds !== (input.durationSeconds ?? null)) {
        throw new QuoteChangedError('Refresh before submitting another studio job.');
      }
      return job;
    }
    if (!quote.credits) return job;
    const reserved = await tx.creditAccount.updateMany({
      where: { workspaceId, available: { gte: quote.credits } },
      data: { available: { decrement: quote.credits } },
    });
    if (!reserved.count) throw new CreditBalanceError('This workspace has insufficient AI credits.');
    await tx.creditEntry.create({
      data: { workspaceId, kind: 'RESERVE', delta: -quote.credits, reference: 'reserve:' + job.id },
    });
    return job;
  });
}

export async function queueAiJob(
  userId: string, slug: string, kind: (typeof aiKinds)[number], prompt: string,
  confirmedCredits: number, requestId: string = randomUUID(),
) {
  const text = prompt.trim();
  if (!text || text.length > 4000) throw new WorkspaceAccessError('Use a prompt of up to 4,000 characters.');
  return queueStudioJob(userId, slug, { kind, prompt: text, requestId }, confirmedCredits);
}

export function validClipRange(startSecond: number, durationSeconds: number) {
  return Number.isInteger(startSecond) && startSecond >= 0 && startSecond <= 3600
    && Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 60;
}

export async function queueClip(
  userId: string, slug: string, sourceAssetId: string, startSecond: number, durationSeconds: number,
  requestId: string = randomUUID(),
) {
  if (!validClipRange(startSecond, durationSeconds)) throw new WorkspaceAccessError('Choose a clip of 1 to 60 seconds.');
  return queueStudioJob(userId, slug, {
    kind: 'CLIP', prompt: 'MP4 clip', requestId, sourceAssetId, startSecond, durationSeconds,
  }, 0);
}

export function queueTranscription(
  userId: string, slug: string, sourceAssetId: string, confirmedCredits: number, requestId: string = randomUUID(),
) {
  return queueStudioJob(userId, slug, { kind: 'TRANSCRIBE', prompt: 'Video audio transcription', requestId, sourceAssetId }, confirmedCredits);
}

export async function saveStudioVideo(userId: string, slug: string, rawLabel: string, bytes: Uint8Array<ArrayBuffer>) {
  const membership = await prisma.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!membership || !canWritePosts(membership.role)) throw new WorkspaceAccessError('You cannot upload workspace video.');
  const { workspaceId } = membership;
  const uploaded = await uploadVideo(workspaceId, bytes);
  const label = rawLabel.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'Uploaded video';
  return prisma.asset.create({ data: { workspaceId, ...uploaded, label } });
}

async function refund(tx: Prisma.TransactionClient, job: { id: string; workspaceId: string; credits: number }) {
  if (!job.credits) return;
  await tx.creditEntry.create({
    data: { workspaceId: job.workspaceId, kind: 'REFUND', delta: job.credits, reference: 'refund:' + job.id },
  });
  await tx.creditAccount.update({ where: { workspaceId: job.workspaceId }, data: { available: { increment: job.credits } } });
}

export async function cancelAiJob(userId: string, slug: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canWritePosts(membership.role)) throw new WorkspaceAccessError('You cannot cancel this AI job.');
    const [job] = await tx.aiJob.updateManyAndReturn({
      where: { id, workspaceId: membership.workspaceId, state: 'QUEUED' },
      data: { state: 'CANCELED', finishedAt: new Date() },
    });
    if (!job) throw new WorkspaceAccessError('Only queued jobs can be canceled.');
    await refund(tx, job);
  });
}

type AiOutcome =
  | { type: 'success'; providerRef: string | null; text?: string; asset?: { key: string; type: string; size: number; checksum: string; label?: string } }
  | { type: 'failed'; error: string; providerRef?: string | null };

export async function finalizeAiJob(id: string, outcome: AiOutcome) {
  return prisma.$transaction(async (tx) => {
    const [job] = await tx.aiJob.updateManyAndReturn({
      where: { id, state: 'RUNNING' },
      data: {
        state: outcome.type === 'success' ? 'SUCCEEDED' : 'FAILED',
        error: outcome.type === 'failed' ? outcome.error : null,
        providerRef: outcome.providerRef ?? null,
        finishedAt: new Date(),
      },
    });
    if (!job) return;
    if (outcome.type === 'failed') {
      await refund(tx, job);
      return;
    }
    const asset = outcome.asset ? await tx.asset.create({ data: { workspaceId: job.workspaceId, ...outcome.asset } }) : null;
    await tx.aiJob.update({
      where: { id }, data: { outputText: outcome.text ?? null, assetId: asset?.id ?? null },
    });
    if (job.credits) await tx.creditEntry.create({
      data: { workspaceId: job.workspaceId, kind: 'CAPTURE', delta: 0, reference: 'capture:' + id },
    });
  });
}

export async function studioHistory(userId: string, slug: string) {
  const workspace = await prisma.workspace.findFirst({
    where: { slug, memberships: { some: { userId } } },
    select: {
      creditAccount: { select: { available: true, entries: {
        orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, delta: true, kind: true },
      } } },
      assets: {
        where: { type: 'video/mp4' }, orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, label: true },
      },
      aiJobs: {
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, kind: true, state: true, prompt: true, credits: true, outputText: true, assetId: true, error: true, startSecond: true, durationSeconds: true },
      },
    },
  });
  return workspace && {
    available: workspace.creditAccount?.available ?? starterCredits(),
    entries: workspace.creditAccount?.entries ?? [],
    jobs: workspace.aiJobs,
    videos: workspace.assets,
  };
}

export function studioAsset(userId: string, slug: string, id: string) {
  return prisma.asset.findFirst({
    where: {
      id, workspace: { slug, memberships: { some: { userId } } },
      OR: [{ type: 'video/mp4' }, { aiJobs: { some: { state: 'SUCCEEDED' } } }],
    },
  });
}

export async function readStudioJobVideo(workspaceId: string, sourceAssetId: string | null) {
  const source = sourceAssetId && await prisma.asset.findFirst({
    where: { id: sourceAssetId, workspaceId, type: 'video/mp4' },
  });
  if (!source) throw new AssetStorageError('The workspace source video is unavailable.');
  return readVideo(source, workspaceId);
}
