import { prisma } from '@cadencedesk/data';
import Stripe from 'stripe';
import { z } from 'zod';

export const paidPlan = z.enum(['creator', 'team', 'agency']);
export const interval = z.enum(['monthly', 'annual']);
type PaidPlan = z.infer<typeof paidPlan>;
type Interval = z.infer<typeof interval>;

export function stripeBilling() {
  const key = process.env.STRIPE_SECRET_KEY;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const appUrl = process.env.APP_URL;
  if (process.env.APP_MODE !== 'hosted' || !key || !secret || !appUrl) return null;
  const url = new URL(appUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))) return null;
  if (!key.startsWith('sk_test_') || !secret.startsWith('whsec_')) return null;
  return { stripe: new Stripe(key, { timeout: 4000, maxNetworkRetries: 0 }), secret, origin: url.origin };
}

export function stripePrices() {
  const configured = paidPlan.options.flatMap((plan) => interval.options.flatMap((period) => {
    const price = process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`];
    return price && /^price_[A-Za-z0-9]+$/.test(price) ? [{ plan, period, price }] : [];
  }));
  return new Set(configured.map(({ price }) => price)).size === configured.length ? configured : [];
}

type Billing = NonNullable<ReturnType<typeof stripeBilling>>;

export async function createSubscriptionCheckout(
  billing: Billing, actorId: string, workspaceId: string, slug: string, plan: PaidPlan, period: Interval,
) {
  const choice = stripePrices().find((entry) => entry.plan === plan && entry.period === period);
  if (!choice) return null;
  const returnUrl = billing.origin + '/app/' + slug + '/billing';
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
    const actor = await tx.membership.findFirst({ where: { userId: actorId, workspaceId, role: { in: ['OWNER', 'ADMIN'] } } });
    if (!actor) return null;
    let account = await tx.billingAccount.findUnique({ where: { workspaceId } });
    if (!account) {
      const customer = await billing.stripe.customers.create({ metadata: { workspaceId } },
        { idempotencyKey: 'cadencedesk-customer-' + workspaceId });
      account = await tx.billingAccount.create({ data: { workspaceId, stripeCustomerId: customer.id } });
    }

    const customer = account.stripeCustomerId;
    const subscriptions = await billing.stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    if (subscriptions.has_more || subscriptions.data.some(({ status }) => status !== 'canceled' && status !== 'incomplete_expired')) {
      return null;
    }
    const open = await billing.stripe.checkout.sessions.list({ customer, status: 'open', limit: 1 });
    const pending = open.data[0];
    if (pending) return pending.metadata?.priceId === choice.price ? pending.url : null;
    const session = await billing.stripe.checkout.sessions.create({
      mode: 'subscription', customer, line_items: [{ price: choice.price, quantity: 1 }],
      success_url: returnUrl + '?status=checkout', cancel_url: returnUrl,
      client_reference_id: workspaceId, metadata: { priceId: choice.price },
    });
    return session.url;
  }, { timeout: 20_000 });
}

export async function syncStripeEvent(billing: Billing, event: Stripe.Event) {
  let customer: string | Stripe.Customer | Stripe.DeletedCustomer | null;
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'checkout.session.completed':
      customer = event.data.object.customer;
      break;
    default:
      return;
  }

  if (!customer) return;
  const stripeCustomerId = typeof customer === 'string' ? customer : customer.id;
  const account = await prisma.billingAccount.findUnique({ where: { stripeCustomerId } });
  if (!account) return;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${account.workspaceId}::uuid FOR UPDATE`;
    const activeAccount = await tx.billingAccount.findUnique({ where: { stripeCustomerId } });
    if (!activeAccount || await tx.stripeEvent.findUnique({ where: { id: event.id } })) return;
    const subscriptions = await billing.stripe.subscriptions.list({ customer: stripeCustomerId, status: 'all', limit: 100 });
    if (subscriptions.has_more) throw new Error('Unexpected subscription count');
    const subscription = subscriptions.data.find(({ status }) => status !== 'canceled' && status !== 'incomplete_expired');
    const item = subscription?.items.data[0];
    await tx.billingAccount.update({
      where: { stripeCustomerId },
      data: {
        stripeSubscriptionId: subscription?.id ?? null, status: subscription?.status ?? null,
        priceId: item?.price.id ?? null, periodEnd: item ? new Date(item.current_period_end * 1000) : null,
        cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
      },
    });
    await tx.stripeEvent.create({ data: { id: event.id, type: event.type, workspaceId: activeAccount.workspaceId } });
  }, { timeout: 10_000 });
}
