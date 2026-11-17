import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import { allowedOutboundUrl } from './outbound';
import { openToken, sealToken, vaultConfigured } from './token-vault';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

export class WebhookConfigurationError extends Error {}

export function webhookConfigured() {
  return Boolean(process.env.WEBHOOK_ALLOWED_ENDPOINTS?.trim()) && vaultConfigured();
}

export function webhookEndpoint(value: string) {
  try {
    return allowedOutboundUrl(value, process.env.WEBHOOK_ALLOWED_ENDPOINTS);
  } catch {
    throw new WebhookConfigurationError('Ask your operator to allow the exact public HTTPS endpoint.');
  }
}

function binding(workspaceId: string, subscriptionId: string) {
  return `webhook/${workspaceId}/${subscriptionId}`;
}

function createSecret(workspaceId: string, subscriptionId: string) {
  const secret = 'whsec_' + randomBytes(32).toString('base64url');
  return { secret, sealed: sealToken(secret, binding(workspaceId, subscriptionId)) };
}

async function requireManager(tx: Prisma.TransactionClient, userId: string, slug: string) {
  const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot manage these webhooks.');
  return membership.workspaceId;
}

export async function addWebhook(userId: string, slug: string, name: string, endpoint: string) {
  const url = webhookEndpoint(endpoint);
  if (!webhookConfigured()) throw new WebhookConfigurationError('Webhook signing requires operator configuration.');
  if (!name.trim() || name.length > 80) throw new WorkspaceAccessError('Choose a subscription name.');
  return prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    const id = randomUUID();
    const { secret, sealed } = createSecret(workspaceId, id);
    const result = await tx.webhookSubscription.createMany({
      data: { id, workspaceId, name, endpoint: url.href, signingSecret: sealed }, skipDuplicates: true,
    });
    if (!result.count) throw new WorkspaceAccessError('This endpoint already has a subscription.');
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: id, action: 'webhook.created' } });
    return { id, secret };
  });
}

export async function rotateWebhookSecret(userId: string, slug: string, id: string) {
  if (!webhookConfigured()) throw new WebhookConfigurationError('Webhook signing requires operator configuration.');
  return prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    const { secret, sealed } = createSecret(workspaceId, id);
    const changed = await tx.webhookSubscription.updateMany({
      where: { id, workspaceId }, data: { signingSecret: sealed },
    });
    if (!changed.count) throw new WorkspaceAccessError('Webhook subscription unavailable.');
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: id, action: 'webhook.secret_rotated' } });
    return secret;
  });
}

export async function setWebhookEnabled(userId: string, slug: string, id: string, enabled: boolean) {
  return prisma.$transaction(async (tx) => {
    const workspaceId = await requireManager(tx, userId, slug);
    const changed = await tx.webhookSubscription.updateMany({ where: { id, workspaceId }, data: { enabled } });
    if (!changed.count) throw new WorkspaceAccessError('Webhook subscription unavailable.');
    if (!enabled) {
      await tx.webhookDelivery.updateMany({
        where: { subscriptionId: id, state: 'QUEUED' },
        data: { state: 'SKIPPED', error: 'Subscription paused.' },
      });
    }
    await tx.auditEvent.create({
      data: { workspaceId, actorId: userId, subjectId: id, action: enabled ? 'webhook.enabled' : 'webhook.paused' },
    });
  });
}

export async function listWebhooks(userId: string, slug: string) {
  return prisma.webhookSubscription.findMany({
    where: { workspace: { slug, memberships: { some: { userId, role: { in: ['OWNER', 'ADMIN'] } } } } },
    select: {
      id: true, name: true, endpoint: true, enabled: true,
      deliveries: {
        orderBy: { createdAt: 'desc' }, take: 10,
        select: { id: true, state: true, attemptsCount: true, statusCode: true, createdAt: true, nextAttemptAt: true, error: true },
      },
    },
    orderBy: { name: 'asc' },
  });
}

export async function enqueuePublishedWebhooks(tx: Prisma.TransactionClient, details: {
  workspaceId: string; postId: string; destinationId: string; channelId: string; provider: string;
  externalId: string; permalink: string | null;
}) {
  const { workspaceId, ...data } = details;
  const subscriptions = await tx.webhookSubscription.findMany({
    where: { workspaceId, enabled: true }, select: { id: true },
  });
  if (!subscriptions.length) return;
  const body = JSON.stringify({
    id: details.destinationId, type: 'post.published', createdAt: new Date().toISOString(), data,
  });
  await tx.webhookDelivery.createMany({
    data: subscriptions.map(({ id }) => ({ subscriptionId: id, eventId: details.destinationId, body })),
    skipDuplicates: true,
  });
}

export function webhookSignature(input: {
  workspaceId: string; subscriptionId: string; signingSecret: string; deliveryId: string; timestamp: string; body: string;
}) {
  try {
    const secret = openToken(input.signingSecret, binding(input.workspaceId, input.subscriptionId));
    return createHmac('sha256', secret).update(`${input.timestamp}.${input.deliveryId}.${input.body}`).digest('hex');
  } catch {
    throw new WebhookConfigurationError('The webhook signing secret is unavailable. Rotate it and try again.');
  }
}
