import { z } from 'zod';
import { prisma } from './client';
import { WorkspaceAccessError } from './errors';
import { metaCredentials, metaRequest } from './meta';
import { ProviderConfigurationError } from './provider-contract';
import { canWritePosts } from './publishing';
import { youtubeAccess } from './youtube';

/**
 * Comments inbox: reads comments on posts Superstar published (last 30 days) straight from each network and sends
 * replies as the connected Page / account / channel. Nothing is copied into Superstar's database.
 * Supported: Facebook Pages, Instagram professional accounts, YouTube channels.
 */
export const commentProviders = ['facebook', 'instagram', 'youtube'] as const;
type CommentProvider = (typeof commentProviders)[number];

export type InboxComment = { id: string; author: string; text: string; createdAt: string | null; replies: InboxComment[] };
export type InboxPost = {
  destinationId: string; provider: CommentProvider; channelName: string; permalink: string | null;
  excerpt: string; publishedAt: string | null; comments: InboxComment[]; error?: string;
};

const RECONNECT: Record<CommentProvider, string> = {
  facebook: 'Reconnect this Facebook Page on the Channels page and allow comment access to see its comments.',
  instagram: 'Reconnect this Instagram account on the Channels page and allow comment access to see its comments.',
  youtube: 'Reconnect this YouTube channel on the Channels page and allow comment access to see its comments.',
};

async function member(userId: string, slug: string) {
  const membership = await prisma.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!membership) throw new WorkspaceAccessError('Workspace is unavailable.');
  return membership;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '').slice(0, 5000);

/** Meta answers "does not exist or missing permission" both for deleted posts and for missing comment access. */
function metaFailure(result: { kind: string; error?: string }, provider: 'facebook' | 'instagram') {
  if (result.kind === 'failed' && /does not exist|cannot be loaded/i.test(result.error ?? '')) {
    return `This post can't be loaded from ${provider === 'facebook' ? 'Facebook' : 'Instagram'}: it may have been deleted there, or the connection needs comment access. If the post still exists, reconnect it on the Channels page.`;
  }
  if (result.kind === 'retry' || result.kind === 'uncertain') return 'Comments could not be loaded right now. Try again shortly.';
  return RECONNECT[provider];
}

// ---------- Facebook ----------
const fbComment = z.object({
  id: z.string(), message: z.string().optional(), created_time: z.string().optional(),
  from: z.object({ name: z.string().optional() }).optional(),
});
const fbList = z.object({ data: z.array(fbComment.extend({ comments: z.object({ data: z.array(fbComment) }).optional() })) });

async function facebookComments(channelId: string, workspaceId: string, postId: string): Promise<InboxComment[]> {
  const token = await metaCredentials('facebook', channelId, workspaceId);
  const fields = 'id,message,created_time,from{name},comments.limit(20){id,message,created_time,from{name}}';
  const result = await metaRequest(`${postId}/comments?filter=toplevel&order=reverse_chronological&limit=25&fields=${encodeURIComponent(fields)}`, token);
  if (result.kind !== 'ok') throw new ProviderConfigurationError(metaFailure(result, 'facebook'));
  const parsed = fbList.safeParse(result.json);
  if (!parsed.success) return [];
  const map = (c: z.infer<typeof fbComment>): InboxComment => ({
    id: c.id, author: c.from?.name ?? 'Facebook user', text: text(c.message), createdAt: c.created_time ?? null, replies: [],
  });
  return parsed.data.data.map((c) => ({ ...map(c), replies: (c.comments?.data ?? []).map(map) }));
}

// ---------- Instagram ----------
const igComment = z.object({ id: z.string(), text: z.string().optional(), username: z.string().optional(), timestamp: z.string().optional() });
const igList = z.object({ data: z.array(igComment.extend({ replies: z.object({ data: z.array(igComment) }).optional() })) });

async function instagramComments(channelId: string, workspaceId: string, mediaId: string): Promise<InboxComment[]> {
  const token = await metaCredentials('instagram', channelId, workspaceId);
  const fields = 'id,text,username,timestamp,replies{id,text,username,timestamp}';
  const result = await metaRequest(`${mediaId}/comments?limit=25&fields=${encodeURIComponent(fields)}`, token);
  if (result.kind !== 'ok') throw new ProviderConfigurationError(metaFailure(result, 'instagram'));
  const parsed = igList.safeParse(result.json);
  if (!parsed.success) return [];
  const map = (c: z.infer<typeof igComment>): InboxComment => ({
    id: c.id, author: c.username ? '@' + c.username : 'Instagram user', text: text(c.text), createdAt: c.timestamp ?? null, replies: [],
  });
  return parsed.data.data.map((c) => ({ ...map(c), replies: (c.replies?.data ?? []).map(map) }));
}

// ---------- YouTube ----------
const ytSnippet = z.object({
  authorDisplayName: z.string().optional(), textOriginal: z.string().optional(), textDisplay: z.string().optional(), publishedAt: z.string().optional(),
});
const ytList = z.object({ items: z.array(z.object({
  id: z.string(),
  snippet: z.object({ topLevelComment: z.object({ id: z.string(), snippet: ytSnippet }) }),
  replies: z.object({ comments: z.array(z.object({ id: z.string(), snippet: ytSnippet })) }).optional(),
})).default([]) });

async function youtubeToken(channelId: string, workspaceId: string) {
  const token = await youtubeAccess(channelId, workspaceId);
  if (!token) throw new ProviderConfigurationError(RECONNECT.youtube);
  return token;
}

async function youtubeComments(channelId: string, workspaceId: string, videoId: string): Promise<InboxComment[]> {
  const token = await youtubeToken(channelId, workspaceId);
  const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  url.search = new URLSearchParams({ part: 'snippet,replies', videoId, maxResults: '25', order: 'time', textFormat: 'plainText' }).toString();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (response.status === 403) {
    const body = await response.json().catch(() => ({})) as { error?: { errors?: { reason?: string }[] } };
    // Comments switched off on the video is not an error the user needs to fix.
    if (body.error?.errors?.[0]?.reason === 'commentsDisabled') return [];
    throw new ProviderConfigurationError(RECONNECT.youtube);
  }
  if (!response.ok) throw new ProviderConfigurationError(RECONNECT.youtube);
  const parsed = ytList.safeParse(await response.json());
  if (!parsed.success) return [];
  const map = (id: string, s: z.infer<typeof ytSnippet>): InboxComment => ({
    id, author: s.authorDisplayName ?? 'YouTube user', text: text(s.textOriginal ?? s.textDisplay), createdAt: s.publishedAt ?? null, replies: [],
  });
  return parsed.data.items.map((t) => ({
    ...map(t.snippet.topLevelComment.id, t.snippet.topLevelComment.snippet),
    replies: (t.replies?.comments ?? []).map((r) => map(r.id, r.snippet)).reverse(),
  }));
}

// ---------- Inbox ----------
async function publishedDestinations(workspaceId: string, take: number) {
  return prisma.destination.findMany({
    where: {
      state: 'PUBLISHED', threadIndex: 0, externalId: { not: null },
      channel: { workspaceId, provider: { in: [...commentProviders] } },
      startedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60_000) },
    },
    orderBy: { startedAt: 'desc' }, take,
    include: {
      channel: { select: { id: true, name: true, provider: true, workspaceId: true } },
      post: { select: { revisions: { orderBy: { number: 'desc' }, take: 1, select: { content: true } } } },
    },
  });
}

function fetchFor(provider: CommentProvider, channelId: string, workspaceId: string, externalId: string) {
  if (provider === 'facebook') return facebookComments(channelId, workspaceId, externalId);
  if (provider === 'instagram') return instagramComments(channelId, workspaceId, externalId);
  return youtubeComments(channelId, workspaceId, externalId);
}

/** The latest published posts (up to 20) with their recent comments, newest first. */
export async function commentInbox(userId: string, slug: string): Promise<InboxPost[]> {
  const { workspaceId } = await member(userId, slug);
  const destinations = await publishedDestinations(workspaceId, 20);
  return Promise.all(destinations.map(async (d): Promise<InboxPost> => {
    const provider = d.channel.provider as CommentProvider;
    const base = {
      destinationId: d.id, provider, channelName: d.channel.name, permalink: d.permalink,
      excerpt: (d.post.revisions[0]?.content ?? '').replace(/\s+/g, ' ').slice(0, 160),
      publishedAt: d.startedAt?.toISOString() ?? null,
    };
    try {
      return { ...base, comments: await fetchFor(provider, d.channel.id, workspaceId, d.externalId!) };
    } catch (error) {
      return { ...base, comments: [], error: error instanceof ProviderConfigurationError ? error.message : 'Comments could not be loaded right now. Try again shortly.' };
    }
  }));
}

/** Replies to a comment as the connected Page, account or channel. */
export async function replyToComment(userId: string, slug: string, destinationId: string, commentId: string, rawText: string) {
  const membership = await member(userId, slug);
  if (!canWritePosts(membership.role)) throw new WorkspaceAccessError('You cannot reply on behalf of this workspace.');
  const message = rawText.trim();
  if (!message || message.length > 2000) throw new WorkspaceAccessError('Write a reply of up to 2,000 characters.');
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(commentId)) throw new WorkspaceAccessError('That comment is unavailable.');
  const d = await prisma.destination.findFirst({
    where: { id: destinationId, state: 'PUBLISHED', channel: { workspaceId: membership.workspaceId, provider: { in: [...commentProviders] } } },
    include: { channel: { select: { id: true, provider: true } } },
  });
  if (!d) throw new WorkspaceAccessError('That post is unavailable.');
  const provider = d.channel.provider as CommentProvider;
  const workspaceId = membership.workspaceId;
  if (provider === 'facebook' || provider === 'instagram') {
    const token = await metaCredentials(provider, d.channel.id, workspaceId);
    const path = provider === 'facebook' ? `${commentId}/comments` : `${commentId}/replies`;
    const result = await metaRequest(path, token, new URLSearchParams({ message }));
    if (result.kind !== 'ok') throw new ProviderConfigurationError(result.kind === 'failed' ? result.error.replace('Meta rejected the post', 'Meta rejected the reply') : 'Meta did not confirm the reply. Check the post before trying again.');
  } else {
    const token = await youtubeToken(d.channel.id, workspaceId);
    const response = await fetch('https://www.googleapis.com/youtube/v3/comments?part=snippet', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: message } }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ProviderConfigurationError(response.status === 403 ? RECONNECT.youtube : `YouTube rejected the reply (HTTP ${response.status}).`);
  }
  await prisma.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: d.id, action: 'comment.replied' } });
}
