import { randomUUID } from 'node:crypto';
import { type AiKind, type Prisma } from '@prisma/client';
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

export function aiQuote(kind: AiKind) {
  const model = kind === 'TEXT' ? process.env.OPENAI_TEXT_MODEL : process.env.OPENAI_IMAGE_MODEL;
  const base = Number(kind === 'TEXT' ? process.env.AI_TEXT_BASE_CREDITS : process.env.AI_IMAGE_BASE_CREDITS);
  const markup = Number(process.env.AI_CREDIT_MARKUP ?? 2);
  const credits = Math.ceil(base * markup);
  if (!process.env.OPENAI_API_KEY || !model || !Number.isFinite(base) || base <= 0
    || !Number.isFinite(markup) || markup <= 0 || credits > 1_000_000) return null;
  if (kind === 'IMAGE' && ![
    process.env.OBJECT_STORAGE_ENDPOINT,
    process.env.OBJECT_STORAGE_BUCKET,
    process.env.OBJECT_STORAGE_ACCESS_KEY,
    process.env.OBJECT_STORAGE_SECRET_KEY,
  ].every(Boolean)) return null;
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

export async function queueAiJob(userId: string, slug: string, kind: AiKind, prompt: string, confirmedCredits: number, requestId: string = randomUUID()) {
  const text = prompt.trim();
  if (!text || text.length > 4000) throw new WorkspaceAccessError('Use a prompt of up to 4,000 characters.');
  const quote = aiQuote(kind);
  if (!quote) throw new AiUnavailableError('Configure the AI provider and credit quote.');
  if (confirmedCredits !== quote.credits) throw new QuoteChangedError('The credit quote changed. Review the new price.');
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
    if (!membership || !canWritePosts(membership.role)) throw new WorkspaceAccessError('You cannot create an AI job.');
    const { workspaceId } = membership;
    await initializeAccount(tx, workspaceId);
    const created = await tx.aiJob.createMany({
      data: { workspaceId, requestId, kind, prompt: text, ...quote }, skipDuplicates: true,
    });
    const job = await tx.aiJob.findUniqueOrThrow({ where: { workspaceId_requestId: { workspaceId, requestId } } });
    if (!created.count) {
      if (job.kind !== kind || job.prompt !== text || job.credits !== quote.credits || job.model !== quote.model) {
        throw new QuoteChangedError('Refresh before submitting another generation.');
      }
      return job;
    }
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

async function refund(tx: Prisma.TransactionClient, job: { id: string; workspaceId: string; credits: number }) {
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
  | { type: 'success'; providerRef: string | null; text?: string; image?: { key: string; type: string; size: number; checksum: string } }
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
    const asset = outcome.image ? await tx.asset.create({ data: { workspaceId: job.workspaceId, ...outcome.image } }) : null;
    await tx.aiJob.update({
      where: { id }, data: { outputText: outcome.text ?? null, assetId: asset?.id ?? null },
    });
    await tx.creditEntry.create({
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
      aiJobs: {
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, kind: true, state: true, prompt: true, credits: true, outputText: true, assetId: true, error: true },
      },
    },
  });
  return workspace && {
    available: workspace.creditAccount?.available ?? starterCredits(),
    entries: workspace.creditAccount?.entries ?? [],
    jobs: workspace.aiJobs,
  };
}

export function studioAsset(userId: string, slug: string, id: string) {
  return prisma.asset.findFirst({
    where: { id, workspace: { slug, memberships: { some: { userId } } }, aiJobs: { some: { state: 'SUCCEEDED' } } },
  });
}
