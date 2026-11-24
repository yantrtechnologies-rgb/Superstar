'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { rescheduleAction } from '../posts/composer-actions';

/**
 * Adds drag-to-reschedule to the server-rendered calendar.
 * Draggable posts carry data-post-id, data-at (ISO time) and data-date/data-hour of their slot;
 * drop targets carry data-date (and data-hour in the day view). The new time keeps the original
 * time of day unless the post is dropped on an hour row.
 */
export function CalendarDrag({ workspace, children }: { workspace: string; children: ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  function target(element: EventTarget | null) {
    return element instanceof HTMLElement ? element.closest<HTMLElement>('[data-date]:not([data-post-id])') : null;
  }

  return (
    <div
      className={pending ? 'calendar-drag busy' : 'calendar-drag'}
      onDragStart={(event) => {
        const post = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-post-id]') : null;
        if (!post) return;
        event.dataTransfer.setData('application/x-superstar-post', JSON.stringify({
          id: post.dataset.postId, at: post.dataset.at, date: post.dataset.date, hour: post.dataset.hour,
        }));
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event) => {
        if (target(event.target) && event.dataTransfer.types.includes('application/x-superstar-post')) {
          event.preventDefault();
          target(event.target)?.classList.add('drop-hover');
        }
      }}
      onDragLeave={(event) => target(event.target)?.classList.remove('drop-hover')}
      onDrop={(event) => {
        const cell = target(event.target);
        cell?.classList.remove('drop-hover');
        const raw = event.dataTransfer.getData('application/x-superstar-post');
        if (!cell || !raw) return;
        event.preventDefault();
        const source = JSON.parse(raw) as { id: string; at: string; date: string; hour?: string };
        const days = Math.round((Date.parse(cell.dataset.date + 'T00:00:00Z') - Date.parse(source.date + 'T00:00:00Z')) / 86_400_000);
        const hours = cell.dataset.hour !== undefined && source.hour !== undefined ? Number(cell.dataset.hour) - Number(source.hour) : 0;
        if (!days && !hours) return;
        const next = new Date(Date.parse(source.at) + days * 86_400_000 + hours * 3_600_000);
        if (next.getTime() < Date.now()) { setMessage({ text: 'Posts can only be moved to a future time.', bad: true }); return; }
        start(async () => {
          const result = await rescheduleAction(workspace, source.id, next.toISOString());
          setMessage(result.ok ? { text: `Moved to ${next.toLocaleString()}.` } : { text: result.error, bad: true });
          if (result.ok) router.refresh();
        });
      }}
    >
      {message && <p role="status" className={message.bad ? 'status-error' : ''}>{message.text}</p>}
      {children}
    </div>
  );
}
