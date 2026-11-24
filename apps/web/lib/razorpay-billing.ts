import { createHmac, timingSafeEqual } from 'node:crypto';
import { completeCreditPurchase, prisma } from '@cadencedesk/data';
import { z } from 'zod';
import { interval, paidPlan } from './stripe-billing';

type PaidPlan = z.infer<typeof paidPlan>;
type Interval = z.infer<typeof interval>;

const api = 'https://api.razorpay.com/v1';
// Subscription states that still hold or are about to hold a paid plan; a new checkout is refused while one exists.
const liveStates = new Set(['authenticated', 'active', 'pending', 'halted', 'paused']);
const subscription = z.object({
  id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
  plan_id: z.string(),
  status: z.string(),
  short_url: z.string().url().nullish(),
  current_end: z.number().nullish(),
  notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullish(),
});

/** Returns the Razorpay configuration, or null when Razorpay billing is not enabled for this installation. */
export function razorpayBilling() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const appUrl = process.env.APP_URL;
  if (process.env.APP_MODE !== 'hosted' || !keyId || !keySecret || !webhookSecret || !appUrl) return null;
  const live = keyId.startsWith('rzp_live_');
  if (!keyId.startsWith('rzp_test_') && !live) return null;
  if (live && process.env.RAZORPAY_ALLOW_LIVE !== 'true') return null;
  const url = new URL(appUrl);
  if (!['http:', 'https:'].includes(url.protocol) || (live && url.protocol !== 'https:')) return null;
  return { keyId, keySecret, webhookSecret, origin: url.origin, live };
}

type Billing = NonNullable<ReturnType<typeof razorpayBilling>>;

/** Plans configured as RAZORPAY_PLAN_<PLAN>_<INTERVAL>=plan_xxx. Duplicated plan IDs disable the catalog. */
export function razorpayPlans() {
  const configured = paidPlan.options.flatMap((plan) => interval.options.flatMap((period) => {
    const id = process.env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${period.toUpperCase()}`];
    return id && /^plan_[A-Za-z0-9]+$/.test(id) ? [{ plan, period, id }] : [];
  }));
  return new Set(configured.map(({ id }) => id)).size === configured.length ? configured : [];
}

async function call(billing: Billing, method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(api + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${billing.keyId}:${billing.keySecret}`).toString('base64'),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const description = (json as { error?: { description?: string } }).error?.description;
    console.error(JSON.stringify({ event: 'razorpay.request_failed', path: path.replace(/sub_[A-Za-z0-9]+/, 'sub_*'), status: response.status, description }));
    throw new Error('Razorpay request failed');
  }
  return json;
}

/** Creates (or reuses) a Razorpay subscription for the workspace and returns its hosted payment link. */
export async function createRazorpayCheckout(
  billing: Billing, actorId: string, workspaceId: string, plan: PaidPlan, period: Interval,
) {
  const choice = razorpayPlans().find((entry) => entry.plan === plan && entry.period === period);
  if (!choice) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
    const actor = await tx.membership.findFirst({ where: { userId: actorId, workspaceId, role: { in: ['OWNER', 'ADMIN'] } } });
    if (!actor) return null;
    const existing = await tx.razorpaySubscription.findUnique({ where: { workspaceId } });
    if (existing && liveStates.has(existing.status)) return null;
    // One payment provider per workspace: refuse while a Stripe subscription is not fully ended.
    const stripe = await tx.billingAccount.findUnique({ where: { workspaceId } });
    if (stripe?.stripeSubscriptionId && stripe.status && !['canceled', 'incomplete_expired'].includes(stripe.status)) return null;
    if (existing?.status === 'created' && existing.planId === choice.id && existing.shortUrl) return existing.shortUrl;
    const created = subscription.parse(await call(billing, 'POST', '/subscriptions', {
      plan_id: choice.id,
      // Razorpay requires a finite number of billing cycles: 10 years either way.
      total_count: period === 'monthly' ? 120 : 10,
      quantity: 1,
      customer_notify: 1,
      notes: { workspace_id: workspaceId },
    }));
    if (!created.short_url) throw new Error('Razorpay did not return a payment link');
    const values = {
      subscriptionId: created.id, planId: created.plan_id, status: created.status, shortUrl: created.short_url,
      currentEnd: created.current_end ? new Date(created.current_end * 1000) : null, cancelAtCycleEnd: false,
    };
    await tx.razorpaySubscription.upsert({ where: { workspaceId }, create: { workspaceId, ...values }, update: values });
    return created.short_url;
  }, { timeout: 20_000 });
}

/** Cancels the workspace subscription at the end of the current billing cycle. */
export async function cancelRazorpaySubscription(billing: Billing, actorId: string, workspaceId: string) {
  const actor = await prisma.membership.findFirst({ where: { userId: actorId, workspaceId, role: { in: ['OWNER', 'ADMIN'] } } });
  const current = await prisma.razorpaySubscription.findUnique({ where: { workspaceId } });
  if (!actor || !current || !liveStates.has(current.status)) return false;
  const result = subscription.parse(await call(billing, 'POST', `/subscriptions/${current.subscriptionId}/cancel`, { cancel_at_cycle_end: 1 }));
  await prisma.razorpaySubscription.update({ where: { workspaceId }, data: {
    status: result.status, cancelAtCycleEnd: true,
    currentEnd: result.current_end ? new Date(result.current_end * 1000) : current.currentEnd,
  } });
  return true;
}

/** Constant-time check of X-Razorpay-Signature: hex HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyRazorpaySignature(billing: Billing, rawBody: Buffer, signature: string) {
  const expected = createHmac('sha256', billing.webhookSecret).update(rawBody).digest();
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const webhookEvent = z.object({
  event: z.string(),
  payload: z.object({ subscription: z.object({ entity: subscription }).optional() }).passthrough(),
});

/** Applies a verified subscription.* webhook. Events are de-duplicated by x-razorpay-event-id. */
export async function syncRazorpayEvent(billing: Billing, eventId: string, raw: unknown) {
  // AI credit packs: grant on payment_link.paid (the link is re-read from Razorpay before granting).
  const linkEvent = z.object({ event: z.literal('payment_link.paid'), payload: z.object({ payment_link: z.object({ entity: z.object({ id: z.string() }) }) }) }).safeParse(raw);
  if (linkEvent.success) {
    await settleCreditPaymentLink(billing, linkEvent.data.payload.payment_link.entity.id);
    return;
  }
  const parsed = webhookEvent.safeParse(raw);
  if (!parsed.success || !parsed.data.event.startsWith('subscription.')) return;
  const entity = parsed.data.payload.subscription?.entity;
  if (!entity) return;
  const local = await prisma.razorpaySubscription.findUnique({ where: { subscriptionId: entity.id } });
  if (!local) return;
  // Re-read the subscription from Razorpay so out-of-order deliveries cannot regress the stored state.
  const current = subscription.parse(await call(billing, 'GET', `/subscriptions/${entity.id}`));
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${local.workspaceId}::uuid FOR UPDATE`;
    if (await tx.razorpayEvent.findUnique({ where: { id: eventId } })) return;
    await tx.razorpaySubscription.update({ where: { subscriptionId: entity.id }, data: {
      status: current.status, planId: current.plan_id,
      currentEnd: current.current_end ? new Date(current.current_end * 1000) : null,
      ...(current.status === 'cancelled' || current.status === 'completed' ? { shortUrl: null } : {}),
    } });
    await tx.razorpayEvent.create({ data: { id: eventId, type: parsed.data.event, workspaceId: local.workspaceId } });
  }, { timeout: 10_000 });
}

const paymentLink = z.object({
  id: z.string().regex(/^plink_[A-Za-z0-9]+$/),
  short_url: z.string().url().nullish(),
  status: z.string(),
  amount: z.number().int(),
  amount_paid: z.number().int().nullish(),
  reference_id: z.string().nullish(),
  payments: z.array(z.object({ payment_id: z.string(), status: z.string().nullish() })).nullish(),
});

/** Creates a hosted Razorpay payment page for an AI credit pack; returns its link. */
export async function createCreditPaymentLink(
  billing: Billing, purchase: { id: string; amountPaise: number; credits: number; pack: string; workspace: { slug: string; name: string } },
) {
  const created = paymentLink.parse(await call(billing, 'POST', '/payment_links', {
    amount: purchase.amountPaise,
    currency: 'INR',
    accept_partial: false,
    reference_id: purchase.id,
    description: `Superstar AI credits: ${purchase.credits} credits for ${purchase.workspace.name} (incl. 18% GST)`.slice(0, 2048),
    notes: { purchase_id: purchase.id, pack: purchase.pack },
    callback_url: `${billing.origin}/app/${purchase.workspace.slug}/billing/credits-return`,
    callback_method: 'get',
    expire_by: Math.floor(Date.now() / 1000) + 60 * 60,
    // Offer UPI (scan-to-pay QR on desktop, UPI apps on mobile) alongside cards, net banking and wallets.
    options: { checkout: { method: { upi: '1', card: '1', netbanking: '1', wallet: '1' } } },
  }));
  if (!created.short_url) throw new Error('Razorpay did not return a payment link');
  return { id: created.id, url: created.short_url };
}

/** Re-reads a payment link from Razorpay and, if paid in full, grants its credits (idempotent). */
export async function settleCreditPaymentLink(billing: Billing, linkId: string) {
  if (!/^plink_[A-Za-z0-9]+$/.test(linkId)) return null;
  const link = paymentLink.parse(await call(billing, 'GET', `/payment_links/${linkId}`));
  if (link.status !== 'paid') return null;
  const paymentId = link.payments?.find((p) => p.status === 'captured')?.payment_id ?? link.payments?.[0]?.payment_id ?? null;
  return completeCreditPurchase(link.id, paymentId, link.amount_paid ?? 0);
}

/** Verifies the signature Razorpay appends to the payment-link return URL. */
export function verifyPaymentLinkReturn(billing: Billing, params: URLSearchParams) {
  const [linkId, reference, status, paymentId, signature] = ['razorpay_payment_link_id', 'razorpay_payment_link_reference_id',
    'razorpay_payment_link_status', 'razorpay_payment_id', 'razorpay_signature'].map((name) => params.get(name) ?? '');
  if (!linkId || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return null;
  const expected = createHmac('sha256', billing.keySecret).update(`${linkId}|${reference}|${status}|${paymentId}`).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? { linkId, status } : null;
}

export function isRazorpayPaid(status: string | null | undefined) {
  return status === 'active' || status === 'authenticated';
}
