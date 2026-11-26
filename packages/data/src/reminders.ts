import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createTransport, type Transporter } from 'nodemailer';
import { z } from 'zod';
import { prisma } from './client';
import { assertChannelCapacity } from './plans';
import type { PublishResult, ReminderProviderAdapter } from './provider-contract';
import { canManageTeam, WorkspaceAccessError } from './workspaces';

/**
 * Reminder channels cover places no app can post to: Facebook personal profiles and Groups (Meta removed that access
 * in 2018 and 2024), Instagram personal accounts, TikTok without an approved app. When a post is due, a workspace
 * member is emailed the post kit; the Reminders page has the text to copy, the media to download and a link to open
 * the network. The destination counts as "reminder sent" (PUBLISHED), and is marked posted once someone confirms it.
 */
export const reminderNetworks = {
  'facebook-profile': { name: 'Facebook profile', open: 'https://www.facebook.com/' },
  'facebook-group': { name: 'Facebook Group', open: 'https://www.facebook.com/groups/feed/' },
  'instagram-personal': { name: 'Instagram personal account', open: 'https://www.instagram.com/' },
  tiktok: { name: 'TikTok', open: 'https://www.tiktok.com/upload' },
  other: { name: 'Other network', open: null },
} as const;
export type ReminderNetwork = keyof typeof reminderNetworks;
const networkId = z.enum(Object.keys(reminderNetworks) as [ReminderNetwork, ...ReminderNetwork[]]);

/** The network a reminder channel stands for, from its external id (`<network>:<uuid>`). */
export function reminderNetwork(externalId: string) {
  const parsed = networkId.safeParse(externalId.split(':')[0]);
  const id = parsed.success ? parsed.data : 'other';
  return { id, ...reminderNetworks[id] };
}

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

async function managerOf(tx: Prisma.TransactionClient, userId: string, slug: string) {
  const membership = await tx.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!membership || !canManageTeam(membership.role)) throw new WorkspaceAccessError('You cannot manage these channels.');
  return membership.workspaceId;
}

/** Adds a reminder channel. The recipient must be a workspace member, so reminders only ever go to the team. */
export async function addReminderChannel(userId: string, slug: string, input: { name: string; network: string; recipientId: string }) {
  const { name, network, recipientId } = z.object({
    name: z.string().trim().min(1).max(80), network: networkId, recipientId: z.uuid(),
  }).parse(input);
  return prisma.$transaction(async (tx) => {
    const workspaceId = await managerOf(tx, userId, slug);
    const recipient = await tx.membership.findFirst({ where: { workspaceId, userId: recipientId }, include: { user: { select: { email: true } } } });
    if (!recipient?.user.email) throw new WorkspaceAccessError('Choose a workspace member to remind.');
    const externalId = `${network}:${randomUUID()}`;
    await assertChannelCapacity(tx, workspaceId, [{ provider: 'reminder', externalId }]);
    const channel = await tx.channel.create({
      data: { workspaceId, provider: 'reminder', externalId, name, reminderEmail: recipient.user.email },
    });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: channel.id, action: 'channel.connected' } });
    return channel;
  }, serializable);
}

/** Workspace members a reminder channel can email (for the manager adding one). */
export async function reminderRecipients(userId: string, slug: string) {
  const members = await prisma.membership.findMany({
    where: { workspace: { slug, memberships: { some: { userId } } } },
    select: { userId: true, user: { select: { email: true, name: true } } },
  });
  return members.filter(({ user }) => user.email).map(({ userId: id, user }) => ({ id, email: user.email!, name: user.name }))
    .sort((a, b) => (a.id === userId ? -1 : b.id === userId ? 1 : a.email.localeCompare(b.email)));
}

/** Removes a reminder channel. One with publishing history is kept for that history, with its reminders turned off. */
export async function removeReminderChannel(userId: string, slug: string, channelId: string) {
  await prisma.$transaction(async (tx) => {
    const workspaceId = await managerOf(tx, userId, slug);
    const channel = await tx.channel.findFirst({ where: { id: channelId, workspaceId, provider: 'reminder' }, include: { _count: { select: { destinations: true } } } });
    if (!channel) throw new WorkspaceAccessError('Channel unavailable.');
    if (channel._count.destinations) await tx.channel.update({ where: { id: channelId }, data: { reminderEmail: null } });
    else await tx.channel.delete({ where: { id: channelId } });
    await tx.auditEvent.create({ data: { workspaceId, actorId: userId, subjectId: channelId, action: 'channel.oauth_disconnected' } });
  }, serializable);
}

/** Reminders sent in the last 60 days, newest first, with the text and media to post. */
export async function listReminders(userId: string, slug: string) {
  const destinations = await prisma.destination.findMany({
    where: {
      parentId: null, state: 'PUBLISHED', channel: { provider: 'reminder' },
      post: { workspace: { slug, memberships: { some: { userId } } } },
      attempts: { some: { finishedAt: { gte: new Date(Date.now() - 60 * 86_400_000) } } },
    },
    include: {
      channel: { select: { id: true, name: true, externalId: true } },
      attempts: { orderBy: { number: 'desc' }, take: 1, select: { finishedAt: true } },
    },
    take: 100,
  });
  const revisions = await prisma.postRevision.findMany({
    where: { OR: destinations.map(({ postId, revision }) => ({ postId, number: revision })) },
    select: { postId: true, number: true, content: true, overrides: true, mediaIds: true, assetId: true },
  });
  return destinations.map((destination) => {
    const revision = revisions.find(({ postId, number }) => postId === destination.postId && number === destination.revision);
    const overrides = (revision?.overrides ?? {}) as Record<string, unknown>;
    const custom = overrides[destination.channelId];
    return {
      id: destination.id, postId: destination.postId,
      channelName: destination.channel.name, network: reminderNetwork(destination.channel.externalId),
      sentAt: destination.attempts[0]?.finishedAt ?? null,
      text: typeof custom === 'string' ? custom : revision?.content ?? '',
      mediaIds: revision?.mediaIds.length ? revision.mediaIds : revision?.assetId ? [revision.assetId] : [],
      confirmedAt: destination.confirmedAt, permalink: destination.permalink,
    };
  }).sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
}

/** Marks a reminded post as posted by hand, optionally with the link to the live post. */
export async function confirmReminder(userId: string, slug: string, destinationId: string, link?: string) {
  const permalink = link?.trim() ? z.url({ protocol: /^https$/ }).max(500).parse(link.trim()) : undefined;
  const membership = await prisma.membership.findFirst({ where: { userId, workspace: { slug } } });
  if (!membership || !(canManageTeam(membership.role) || membership.role === 'EDITOR')) throw new WorkspaceAccessError('You cannot update these reminders.');
  const updated = await prisma.destination.updateMany({
    where: { id: destinationId, state: 'PUBLISHED', channel: { provider: 'reminder', workspaceId: membership.workspaceId } },
    data: { confirmedAt: new Date(), ...(permalink ? { permalink } : {}) },
  });
  if (!updated.count) throw new WorkspaceAccessError('Reminder unavailable.');
  await prisma.auditEvent.create({ data: { workspaceId: membership.workspaceId, actorId: userId, subjectId: destinationId, action: 'reminder.confirmed' } });
}

let transport: Transporter | undefined;

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Sends with the same settings as sign-in email: SMTP when configured, otherwise Resend. */
async function sendEmail(to: string, subject: string, text: string, html: string): Promise<'sent' | 'unavailable' | 'failed'> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, RESEND_API_KEY } = process.env;
  const smtp = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASSWORD);
  const from = process.env.EMAIL_FROM || (smtp ? `Superstar <${SMTP_USER}>` : undefined);
  if (!from || (!smtp && !RESEND_API_KEY)) return 'unavailable';
  try {
    if (SMTP_HOST && SMTP_USER && SMTP_PASSWORD) {
      const port = Number(SMTP_PORT || 465);
      transport ??= createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: { user: SMTP_USER, pass: SMTP_PASSWORD.replace(/\s+/g, '') } });
      await transport.sendMail({ from, to, subject, text, html });
      return 'sent';
    }
    const response = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    return response.ok ? 'sent' : 'failed';
  } catch (error) {
    console.error(JSON.stringify({ event: 'reminder.email_failed', code: (error as { code?: string }).code }));
    return 'failed';
  }
}

export const reminder: ReminderProviderAdapter = {
  kind: 'reminder',
  name: 'Reminder (you post it)',
  textLimit: 63_206,
  imageCaptionLimit: 63_206,
  acceptsVideo: true,
  maxImages: 10,
  connectionHelp: 'For places no app can post to, such as Facebook profiles and Groups. When the post is due, Superstar emails you the text and media, and you post it yourself.',
  async publish(workspace, channel, nonce, content, _image, images): Promise<PublishResult> {
    const found = await prisma.channel.findUnique({ where: { id: channel.id }, select: { name: true, externalId: true, reminderEmail: true, workspaceId: true } });
    if (!found?.reminderEmail) return { kind: 'failed', error: 'Reminders are turned off for this channel.' };
    const member = await prisma.membership.findFirst({ where: { workspaceId: found.workspaceId, user: { email: found.reminderEmail } } });
    if (!member) return { kind: 'failed', error: 'The person this channel reminds is no longer in the workspace. Add the channel again with a current member.' };
    const network = reminderNetwork(found.externalId);
    const page = process.env.APP_URL ? new URL(`/app/${workspace}/reminders`, process.env.APP_URL).href : null;
    const media = images?.length ? `${images.length} media file${images.length > 1 ? 's' : ''} to download on the Reminders page.` : 'No media.';
    const subject = `Time to post on ${found.name} (${network.name})`;
    const text = `${subject}\n\nPost this text:\n\n${content}\n\n${media}${page ? `\n\nOpen the post kit: ${page}` : ''}`;
    const html = `<div style="font-family:Arial,sans-serif;color:#202623;max-width:560px">
<p style="font-weight:bold">Superstar</p><p style="font-size:20px;font-weight:bold">${escapeHtml(subject)}</p>
<p>Post this text:</p><pre style="white-space:pre-wrap;font-family:inherit;background:#f6f5f0;padding:12px;border-radius:8px">${escapeHtml(content)}</pre>
<p>${escapeHtml(media)}</p>${page ? `<p><a href="${escapeHtml(page)}" style="background:#acf0d3;color:#153c2f;padding:12px 18px;text-decoration:none;display:inline-block">Open the post kit</a></p>` : ''}
<p style="color:#666;font-size:12px">${escapeHtml(network.name)} doesn't let apps post for you, so Superstar reminds you instead. Mark it as posted on the Reminders page.</p></div>`;
    const sent = await sendEmail(found.reminderEmail, subject, text, html);
    if (sent === 'unavailable') return { kind: 'failed', error: 'Email is not set up on this server, so the reminder could not be sent.' };
    if (sent === 'failed') return { kind: 'retry', delayMs: 5 * 60_000 };
    return { kind: 'published', externalId: 'reminder-' + nonce, permalink: null };
  },
};
