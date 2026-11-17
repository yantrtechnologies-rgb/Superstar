import { z } from 'zod';

const limits = z.object({
  channels: z.number().int().nonnegative().optional(),
  seats: z.number().int().positive().optional(),
  scheduledDestinations: z.number().int().nonnegative().optional(),
  analyticsRetentionDays: z.number().int().nonnegative().optional(),
  automationRules: z.number().int().nonnegative().optional(),
  apiRequestsPerMinute: z.number().int().nonnegative().optional(),
  includedAiCredits: z.number().int().nonnegative().optional(),
}).strict();

export const plans = [
  { id: 'free', name: 'Free', audience: 'For trying out your first social campaign.' },
  { id: 'creator', name: 'Creator', audience: 'For independent creators managing their channels.' },
  { id: 'team', name: 'Team', audience: 'For teams that plan and review content together.' },
  { id: 'agency', name: 'Agency', audience: 'For agencies coordinating campaigns across clients.' },
] as const;

const catalog = z.object({
  free: z.object({ limits: limits.optional() }).strict().optional(),
  creator: z.object({ limits: limits.optional() }).strict().optional(),
  team: z.object({ limits: limits.optional() }).strict().optional(),
  agency: z.object({ limits: limits.optional() }).strict().optional(),
}).strict();

export const limitRows = [
  ['channels', 'Connected channels'],
  ['seats', 'Workspace seats'],
  ['scheduledDestinations', 'Scheduled destinations'],
  ['analyticsRetentionDays', 'Analytics history (days)'],
  ['automationRules', 'Automation rules'],
  ['apiRequestsPerMinute', 'API requests per minute'],
  ['includedAiCredits', 'Included AI credits'],
] as const satisfies ReadonlyArray<readonly [keyof z.infer<typeof limits>, string]>;

export function billingCatalog(raw = process.env.BILLING_PLAN_LIMITS) {
  const result = catalog.parse(raw?.trim() ? JSON.parse(raw) : {});
  return plans.map((plan) => ({ ...plan, limits: result[plan.id]?.limits ?? {} }));
}
