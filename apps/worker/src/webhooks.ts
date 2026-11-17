import { request } from 'node:https';
import { pinPublicIpv4, prisma, webhookEndpoint, webhookSignature, WebhookConfigurationError } from '@cadencedesk/data';
import type { WebhookDeliveryState } from '@cadencedesk/data';
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

type Transport = (endpoint: URL, headers: Record<string, string>, body: string) =>
  Promise<{ statusCode: number; retryAfter?: string }>;

const maxAttempts = 5;

async function send(endpoint: URL, headers: Record<string, string>, body: string) {
  const signal = AbortSignal.timeout(12_000);
  const address = await pinPublicIpv4(endpoint.hostname, signal);
  return new Promise<{ statusCode: number; retryAfter?: string }>((resolve, reject) => {
    const req = request(endpoint, {
      method: 'POST', headers, family: 4, agent: false, signal,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    }, (res) => {
      resolve({ statusCode: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] });
      res.destroy();
    });
    req.once('error', reject);
    req.end(body);
  });
}

function retryDelay(attempt: number, retryAfter: string | undefined) {
  const seconds = Number(retryAfter);
  const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? '') - Date.now();
  const delay = Number.isFinite(serverDelay) && serverDelay > 0 ? serverDelay : 5000 * 2 ** (attempt - 1);
  return Math.min(Math.max(delay, 1000), 60 * 60_000);
}

async function claimDelivery(id: string, now: Date) {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.webhookDelivery.updateManyAndReturn({
      where: {
        id, attemptsCount: { lt: maxAttempts },
        OR: [
          { state: 'QUEUED', nextAttemptAt: { lte: now } },
          { state: 'SENDING', leasedUntil: { lte: now } },
        ],
      },
      data: {
        state: 'SENDING', leasedUntil: new Date(now.getTime() + 45_000), attemptsCount: { increment: 1 },
      },
    });
    if (!row) return null;
    await tx.webhookAttempt.updateMany({
      where: { deliveryId: id, state: 'SENDING' },
      data: { state: 'FAILED', error: 'Worker stopped before confirming the request.', finishedAt: now },
    });
    await tx.webhookAttempt.create({ data: { deliveryId: id, number: row.attemptsCount, state: 'SENDING' } });
    return tx.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
  });
}

async function waitForClaim(id: string, now: Date) {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id } });
  if (delivery?.state === 'QUEUED') return Math.max(1, delivery.nextAttemptAt.getTime() - now.getTime());
  if (delivery?.state !== 'SENDING' || !delivery.leasedUntil) return null;
  const remaining = delivery.leasedUntil.getTime() - now.getTime();
  if (remaining > 0 || delivery.attemptsCount < maxAttempts) return Math.max(1, remaining);
  await prisma.$transaction(async (tx) => {
    const error = 'The last attempt stopped before confirming delivery.';
    const result = await tx.webhookDelivery.updateMany({
      where: { id, state: 'SENDING', attemptsCount: maxAttempts, leasedUntil: { lte: now } },
      data: { state: 'FAILED', error, leasedUntil: null },
    });
    if (result.count) {
      await tx.webhookAttempt.updateMany({
        where: { deliveryId: id, state: 'SENDING' },
        data: { state: 'FAILED', error, finishedAt: now },
      });
    }
  });
  return null;
}

export async function deliverWebhook(id: string, transport: Transport = send): Promise<number | null> {
  const now = new Date();
  const delivery = await claimDelivery(id, now);
  if (!delivery) return waitForClaim(id, now);

  const { subscription, attemptsCount, body } = delivery;
  let state: WebhookDeliveryState = 'FAILED';
  let statusCode: number | null = null;
  let error: string | null = null;
  let delay: number | null = null;

  if (!subscription.enabled) {
    state = 'SKIPPED';
    error = 'Subscription paused.';
  } else {
    try {
      const endpoint = webhookEndpoint(subscription.endpoint);
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const signature = webhookSignature({
        workspaceId: subscription.workspaceId, subscriptionId: subscription.id, signingSecret: subscription.signingSecret,
        deliveryId: id, timestamp, body,
      });
      const response = await transport(endpoint, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'User-Agent': 'CadenceDesk-Webhook/1.0',
        'X-CadenceDesk-Delivery': id,
        'X-CadenceDesk-Event': 'post.published',
        'X-CadenceDesk-Timestamp': timestamp,
        'X-CadenceDesk-Signature': 'v1=' + signature,
      }, body);
      statusCode = response.statusCode;
      if (statusCode >= 200 && statusCode < 300) state = 'DELIVERED';
      else {
        error = `The receiver returned HTTP ${statusCode}.`;
        if (attemptsCount < maxAttempts && (statusCode >= 500 || [408, 425, 429].includes(statusCode))) {
          delay = retryDelay(attemptsCount, response.retryAfter);
        }
      }
    } catch (cause) {
      error = cause instanceof WebhookConfigurationError ? cause.message : 'The receiver could not be reached.';
      if (!(cause instanceof WebhookConfigurationError) && attemptsCount < maxAttempts) {
        delay = retryDelay(attemptsCount, undefined);
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    const finishedAt = new Date();
    const changed = await tx.webhookDelivery.updateMany({
      where: { id, state: 'SENDING', attemptsCount },
      data: {
        state: delay === null ? state : 'QUEUED', statusCode, error, leasedUntil: null,
        ...(delay === null ? {} : { nextAttemptAt: new Date(finishedAt.getTime() + delay) }),
      },
    });
    if (!changed.count) return;
    await tx.webhookAttempt.update({
      where: { deliveryId_number: { deliveryId: id, number: attemptsCount } },
      data: { state, statusCode, error, finishedAt },
    });
  });
  return delay;
}

export async function dispatchWebhooks(client: Client) {
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { dispatchedAt: null, state: 'QUEUED' },
    orderBy: { nextAttemptAt: 'asc' }, take: 40, select: { id: true },
  });
  for (const { id } of deliveries) {
    try {
      await client.workflow.start('deliverPublishedWebhook', {
        taskQueue: 'cadencedesk', workflowId: 'webhook-' + id,
        workflowIdReusePolicy: 'REJECT_DUPLICATE', args: [id],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    await prisma.webhookDelivery.updateMany({ where: { id, dispatchedAt: null }, data: { dispatchedAt: new Date() } });
  }
}
