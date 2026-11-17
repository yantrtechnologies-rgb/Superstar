import { DateTime } from 'luxon';
import type { Prisma } from '@prisma/client';
import { WorkspaceAccessError } from './workspaces';

type Slot = { weekday: number; minute: number };
export class PostingSlotUnavailableError extends WorkspaceAccessError {}

export function nextAvailableSlot(
  targetSlots: Slot[][], timeZone: string, now: Date, occupiedMinutes: ReadonlySet<number>,
) {
  const [first, ...rest] = targetSlots;
  if (!first?.length) return null;
  const shared = first.filter((slot) =>
    rest.every((slots) => slots.some(({ weekday, minute }) => weekday === slot.weekday && minute === slot.minute)));
  if (!shared.length) return null;
  shared.sort((a, b) => a.minute - b.minute);
  const start = DateTime.fromJSDate(now, { zone: timeZone }).startOf('day');
  if (!start.isValid) return null;
  for (let offset = 0; offset < 35; offset++) {
    const date = start.plus({ days: offset });
    for (const slot of shared) {
      if (slot.weekday !== date.weekday) continue;
      const hour = Math.floor(slot.minute / 60);
      const minute = slot.minute % 60;
      const candidate = DateTime.fromObject({ year: date.year, month: date.month, day: date.day, hour, minute }, { zone: timeZone });
      if (candidate.hour !== hour || candidate.minute !== minute) continue;
      const ms = Math.min(...candidate.getPossibleOffsets().map((instant) => instant.toMillis()));
      if (ms > now.getTime() && !occupiedMinutes.has(Math.floor(ms / 60_000))) return new Date(ms);
    }
  }
  return null;
}

export async function findNextPostingSlot(tx: Prisma.TransactionClient, workspaceId: string, channelIds: string[]) {
  const now = new Date();
  const workspace = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId }, select: { timeZone: true },
  });
  const [channels, existing] = await Promise.all([
    tx.channel.findMany({
      where: { workspaceId, id: { in: channelIds } },
      select: { postingSlots: { select: { weekday: true, minute: true } } },
    }),
    tx.destination.findMany({
      where: {
        channelId: { in: channelIds }, state: { in: ['SCHEDULED', 'PUBLISHING', 'PUBLISHED'] },
        post: { workspaceId, scheduledAt: { gte: now, lte: new Date(now.getTime() + 36 * 86_400_000) } },
      },
      select: { post: { select: { scheduledAt: true } } },
    }),
  ]);
  const minutes = new Set(existing.flatMap(({ post }) =>
    post.scheduledAt ? [Math.floor(post.scheduledAt.getTime() / 60_000)] : []));
  const selected = nextAvailableSlot(channels.map(({ postingSlots }) => postingSlots), workspace.timeZone, now, minutes);
  if (!selected || channels.length !== channelIds.length) throw new PostingSlotUnavailableError('No shared posting slot was available.');
  return selected;
}
