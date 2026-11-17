import { z } from 'zod';

export const apiScopes = ['channels:read', 'posts:read', 'posts:write', 'posts:schedule'] as const;
export type ApiScope = (typeof apiScopes)[number];
export const workspaceSlug = z.string().regex(/^[a-z0-9-]{1,64}$/);
export const keyInput = z.object({
  name: z.string().trim().min(1).max(80),
  days: z.coerce.number().int().min(1).max(90),
  scopes: z.array(z.enum(apiScopes)).min(1).max(apiScopes.length),
});

const followUp = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  delayMinutes: z.number().int().min(1).max(10_080),
});

export const createDraftInput = z.strictObject({
  content: z.string().trim().min(1).max(4096),
  followUp: followUp.optional(),
});

export const submitRevisionInput = z.strictObject({
  revision: z.number().int().positive(),
  channelIds: z.array(z.uuid()).min(1).max(20),
});

export const scheduleRevisionInput = z.discriminatedUnion('mode', [
  submitRevisionInput.extend({ mode: z.literal('now') }),
  submitRevisionInput.extend({ mode: z.literal('next') }),
  submitRevisionInput.extend({ mode: z.literal('at'), scheduledAt: z.iso.datetime() }),
]);

export const pageInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const apiKeyPattern = /^cdk_[A-Za-z0-9_-]{43}$/;

export const apiChannelResource = z.object({
  id: z.uuid(), name: z.string(), provider: z.string(), clientGroupId: z.uuid().nullable(),
});

export const apiPostResource = z.object({
  id: z.uuid(),
  state: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANCELED']),
  revision: z.number().int(),
  createdAt: z.iso.datetime(),
  scheduledAt: z.iso.datetime().nullable(),
  content: z.object({
    content: z.string(),
    channelIds: z.array(z.uuid()),
    followUpText: z.string().nullable(),
    followUpDelayMinutes: z.number().int().nullable(),
  }).nullable(),
  destinations: z.array(z.object({
    id: z.uuid(), channelId: z.uuid(),
    state: z.enum(['SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'CANCELED', 'FAILED', 'UNCERTAIN']),
    permalink: z.string().nullable(), parentId: z.uuid().nullable(),
    error: z.string().nullable(), externalId: z.string().nullable(),
  })),
});

export const apiChannelPage = z.object({ items: z.array(apiChannelResource), nextOffset: z.number().int().nullable() });
export const apiPostPage = z.object({ items: z.array(apiPostResource), nextOffset: z.number().int().nullable() });
