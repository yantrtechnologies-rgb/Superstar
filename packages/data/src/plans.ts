import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import { WorkspaceAccessError } from './errors';

/**
 * Superstar plans. Prices are monthly, in Indian rupees, before GST (18% is added at checkout).
 * Limits apply only when APP_MODE=hosted (the paid, hosted service); self-hosted installs have no limits.
 */
export const planIds = ['free', 'creator', 'team', 'agency'] as const;
export type PlanId = (typeof planIds)[number];

export const GST_RATE = 0.18;

export const planCatalog: Record<PlanId, { name: string; monthlyInr: number; channels: number; seats: number; tagline: string }> = {
  free: { name: 'Free', monthlyInr: 0, channels: 1, seats: 1, tagline: 'Try Superstar with one channel.' },
  creator: { name: 'Creator', monthlyInr: 1000, channels: 3, seats: 1, tagline: 'For creators running their own brand.' },
  team: { name: 'Team', monthlyInr: 2500, channels: 5, seats: 5, tagline: 'For small brands planning content together.' },
  agency: { name: 'Agency', monthlyInr: 6000, channels: 10, seats: 15, tagline: 'For agencies running campaigns for clients.' },
};

/** What every plan includes, and what is added on higher plans (only features Superstar actually has). */
export const planFeatures: Record<PlanId, string[]> = {
  free: [
    'Unlimited posts',
    'Calendar, drafts and scheduling',
    'Post previews for every network',
    'Media library',
  ],
  creator: [
    'Everything in Free',
    'Threads and follow-up comments',
    'Repeating posts and posting slots',
    'Signatures',
    'RSS auto-posting',
    'AI Studio for writing and images',
    'Analytics',
  ],
  team: [
    'Everything in Creator',
    'Team members with roles',
    'Approval workflow and review links',
    'Client groups',
    'Webhooks and REST API',
  ],
  agency: [
    'Everything in Team',
    'Built for managing many client brands',
    'Priority support',
  ],
};

type Db = Prisma.TransactionClient | typeof prisma;

export class PlanLimitError extends WorkspaceAccessError {
  constructor(message: string, readonly slug: string, readonly limit: 'channels' | 'seats') { super(message); }
}

export function billingEnforced() {
  return process.env.APP_MODE === 'hosted';
}

function exemptSlugs() {
  return (process.env.BILLING_EXEMPT_WORKSPACES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Maps a Razorpay plan ID or Stripe price ID back to a Superstar plan using the RAZORPAY_PLAN_* / STRIPE_PRICE_* settings. */
function planFromSetting(prefix: 'RAZORPAY_PLAN_' | 'STRIPE_PRICE_', id: string | null | undefined): PlanId {
  for (const plan of ['creator', 'team', 'agency'] as const) {
    for (const period of ['MONTHLY', 'ANNUAL']) {
      if (id && process.env[`${prefix}${plan.toUpperCase()}_${period}`] === id) return plan;
    }
  }
  // A paid subscription whose plan is no longer configured keeps the smallest paid plan rather than losing access.
  return 'creator';
}

/** The workspace's current plan, or null when no limits apply (billing off, or the workspace is exempt). */
export async function workspacePlan(db: Db, workspaceId: string): Promise<{ id: PlanId; slug: string } | null> {
  if (!billingEnforced()) return null;
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      slug: true, razorpaySubscription: { select: { status: true, planId: true } }, billingAccount: { select: { status: true, priceId: true } },
      memberships: { where: { role: 'OWNER' }, select: { user: { select: { email: true } } } },
    },
  });
  if (!workspace) return null;
  if (exemptSlugs().includes(workspace.slug)) return null;
  // Workspaces owned by an operator/admin account (BILLING_EXEMPT_USERS, comma-separated emails) have no limits.
  const exemptUsers = (process.env.BILLING_EXEMPT_USERS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (exemptUsers.length && workspace.memberships.some((m) => exemptUsers.includes(m.user.email.toLowerCase()))) return null;
  const rzp = workspace.razorpaySubscription;
  // "pending" means Razorpay is retrying a failed charge; keep the plan during those retries.
  if (rzp && ['active', 'authenticated', 'pending'].includes(rzp.status)) return { id: planFromSetting('RAZORPAY_PLAN_', rzp.planId), slug: workspace.slug };
  const stripe = workspace.billingAccount;
  if (stripe?.status && ['active', 'trialing'].includes(stripe.status)) return { id: planFromSetting('STRIPE_PRICE_', stripe.priceId), slug: workspace.slug };
  return { id: 'free', slug: workspace.slug };
}

function upgradeHint(plan: PlanId) {
  return plan === 'agency' ? 'Disconnect a channel first.' : 'Upgrade your plan on the Billing page, or disconnect a channel first.';
}

/** Refuses to add channels beyond the plan. Reconnecting an already-connected account never counts as new. */
export async function assertChannelCapacity(db: Db, workspaceId: string, adding: { provider: string; externalId: string }[]) {
  const plan = await workspacePlan(db, workspaceId);
  if (!plan) return;
  const existing = await db.channel.findMany({ where: { workspaceId }, select: { provider: true, externalId: true } });
  const fresh = adding.filter((a, i) => adding.findIndex((b) => b.provider === a.provider && b.externalId === a.externalId) === i)
    .filter((a) => !existing.some((e) => e.provider === a.provider && e.externalId === a.externalId));
  const limit = planCatalog[plan.id].channels;
  if (fresh.length && existing.length + fresh.length > limit) {
    throw new PlanLimitError(
      `Your ${planCatalog[plan.id].name} plan allows ${limit} channel${limit === 1 ? '' : 's'} and this workspace has ${existing.length}. ${upgradeHint(plan.id)}`,
      plan.slug, 'channels');
  }
}

/** Refuses scheduling while a workspace has more channels than its plan (for example after a downgrade). */
export async function assertWithinChannelPlan(db: Db, workspaceId: string) {
  const plan = await workspacePlan(db, workspaceId);
  if (!plan) return;
  const count = await db.channel.count({ where: { workspaceId } });
  const limit = planCatalog[plan.id].channels;
  if (count > limit) {
    throw new PlanLimitError(
      `Your ${planCatalog[plan.id].name} plan allows ${limit} channel${limit === 1 ? '' : 's'}, but ${count} are connected. Upgrade on the Billing page or disconnect ${count - limit} to schedule posts.`,
      plan.slug, 'channels');
  }
}

/** Refuses invitations and joins beyond the plan's seats. Pending invitations hold a seat. */
export async function assertSeatCapacity(db: Db, workspaceId: string, opts: { invitingEmail?: string; joining?: boolean } = {}) {
  const plan = await workspacePlan(db, workspaceId);
  if (!plan) return;
  const limit = planCatalog[plan.id].seats;
  const members = await db.membership.count({ where: { workspaceId } });
  const pending = opts.joining ? 0 : await db.invitation.count({
    where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() }, ...(opts.invitingEmail ? { NOT: { email: opts.invitingEmail } } : {}) },
  });
  const used = members + pending;
  if (opts.joining ? members >= limit : used >= limit) {
    throw new PlanLimitError(
      limit === 1
        ? `The ${planCatalog[plan.id].name} plan is for one person. Upgrade to Team or Agency on the Billing page to invite team members.`
        : `Your ${planCatalog[plan.id].name} plan includes ${limit} team members, and ${used} seats are used or invited. Upgrade on the Billing page to add more.`,
      plan.slug, 'seats');
  }
}

export function withGst(inr: number) {
  return Math.round(inr * (1 + GST_RATE));
}
