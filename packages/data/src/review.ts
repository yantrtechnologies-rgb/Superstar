import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './client';
import { canWritePosts } from './publishing';
import { WorkspaceAccessError } from './workspaces';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

async function requireEditor(tx: Prisma.TransactionClient, userId: string, slug: string) {
  const scope = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!scope || !canWritePosts(scope.role)) throw new WorkspaceAccessError('You cannot manage review links.');
  return scope;
}

export async function createReviewLink(userId: string, slug: string, postId: string, revision: number, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new WorkspaceAccessError('Choose a valid expiration.');
  const token = randomBytes(32).toString('base64url');
  await prisma.$transaction(async (tx) => {
    const { workspaceId } = await requireEditor(tx, userId, slug);
    const post = await tx.post.findFirst({ where: { workspaceId, id: postId, revision, state: 'IN_REVIEW' } });
    if (!post) throw new WorkspaceAccessError('The draft is no longer in review.');
    const link = await tx.reviewLink.create({
      data: {
        postId, revision, hash: digest(token),
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60_000),
      },
    });
    await tx.auditEvent.create({
      data: { workspaceId, actorId: userId, subjectId: link.id, action: 'review_link.created' },
    });
  }, serializable);
  return token;
}

export async function revokeReviewLink(userId: string, slug: string, linkId: string) {
  await prisma.$transaction(async (tx) => {
    const { workspaceId } = await requireEditor(tx, userId, slug);
    const result = await tx.reviewLink.updateMany({
      where: { id: linkId, post: { workspaceId }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new WorkspaceAccessError('The review link is unavailable.');
    await tx.auditEvent.create({
      data: { workspaceId, actorId: userId, subjectId: linkId, action: 'review_link.revoked' },
    });
  }, serializable);
}

async function readReview(tx: Prisma.TransactionClient, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const link = await tx.reviewLink.findFirst({
    where: { hash: digest(token), revokedAt: null, expiresAt: { gt: new Date() } },
    include: {
      post: { select: { id: true, revision: true, state: true, workspaceId: true, workspace: { select: { name: true } } } },
    },
  });
  return link && link.post.revision === link.revision ? link : null;
}

export async function reviewPreview(token: string) {
  const link = await readReview(prisma, token);
  if (!link) return null;
  const { post, revision } = link;
  const version = await prisma.postRevision.findUnique({
    where: { postId_number: { postId: post.id, number: revision } },
    select: { content: true, channelIds: true, asset: true, followUpText: true, followUpDelayMinutes: true },
  });
  if (!version) return null;
  const [comments, channels] = await Promise.all([
    prisma.editorialComment.findMany({
      where: { postId: post.id, revision, reviewLinkId: link.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, body: true, createdAt: true, action: true },
    }),
    prisma.channel.findMany({
      where: { workspaceId: post.workspaceId, id: { in: version.channelIds } },
      select: { id: true, name: true, provider: true },
    }),
  ]);
  return {
    workspaceName: post.workspace.name, workspaceId: post.workspaceId,
    revision, state: post.state, content: version.content, asset: version.asset, comments, channels,
    followUpText: version.followUpText, followUpDelayMinutes: version.followUpDelayMinutes,
  };
}

export type ReviewDecision = 'COMMENT' | 'APPROVE' | 'CHANGES';

export async function respondToReview(token: string, action: ReviewDecision, body: string) {
  const text = body.trim();
  if (text.length > 2000 || (action !== 'APPROVE' && !text)) {
    throw new WorkspaceAccessError('Enter a comment of up to 2,000 characters.');
  }
  await prisma.$transaction(async (tx) => {
    const link = await readReview(tx, token);
    if (!link || link.post.state !== 'IN_REVIEW') throw new WorkspaceAccessError('This revision is closed for review.');
    const { post, revision } = link;
    if (action !== 'COMMENT') {
      const result = await tx.post.updateMany({
        where: { id: post.id, revision, state: 'IN_REVIEW' },
        data: { state: action === 'APPROVE' ? 'APPROVED' : 'DRAFT' },
      });
      if (!result.count) throw new WorkspaceAccessError('This revision is closed for review.');
      if (action === 'APPROVE') await tx.approval.create({ data: { postId: post.id, revision, reviewLinkId: link.id } });
      if (action === 'CHANGES') {
        await tx.reviewLink.updateMany({ where: { postId: post.id, revision, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    }
    await tx.editorialComment.create({
      data: { postId: post.id, revision, reviewLinkId: link.id, action, body: text },
    });
    await tx.auditEvent.create({
      data: { workspaceId: post.workspaceId, subjectId: post.id, action: `client_review.${action.toLowerCase()}` },
    });
  }, serializable);
}
