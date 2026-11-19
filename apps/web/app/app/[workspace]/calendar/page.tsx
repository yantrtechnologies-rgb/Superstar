import { findMembership, listChannelSettings, listPosts } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';

const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/;

function localDateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export default async function Calendar({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ group?: string; month?: string }>;
}) {
  const user = await requireUser();
  const { workspace } = await params;
  const membership = await findMembership(user.id, workspace);
  if (!membership) notFound();
  const [{ group, month }, settings] = await Promise.all([searchParams, listChannelSettings(user.id, workspace)]);
  const groups = settings?.clientGroups ?? [];
  const selected = groups.find(({ id }) => id === group)?.id;
  const posts = await listPosts(user.id, workspace, true, selected);
  const timeZone = membership.workspace.timeZone;
  const format = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const currentMonth = monthPattern.test(month ?? '') ? month! : localDateKey(new Date(), timeZone).slice(0, 7);
  const year = Number(currentMonth.slice(0, 4));
  const monthNumber = Number(currentMonth.slice(5, 7));
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const leading = first.getUTCDay();
  const cells = Array.from({ length: Math.ceil((leading + days) / 7) * 7 }, (_, index) => {
    const day = index - leading + 1;
    return day >= 1 && day <= days ? day : null;
  });
  const entries = new Map<string, typeof posts>();
  for (const post of posts) {
    if (!post.scheduledAt) continue;
    const key = localDateKey(post.scheduledAt, timeZone);
    entries.set(key, [...(entries.get(key) ?? []), post]);
  }
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7);
  const preserveGroup = selected ? `&group=${encodeURIComponent(selected)}` : '';
  const monthLabel = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);

  return (
    <>
      <h1>Content calendar</h1>
      <p>Scheduled publishing in {timeZone}</p>
      {groups.length > 0 && (
        <form className="identity-form" method="get">
          <label htmlFor="group">Client group</label>
          <select id="group" name="group" defaultValue={selected ?? ''}>
            <option value="">All groups</option>
            {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <input type="hidden" name="month" value={currentMonth} />
          <button type="submit">Filter calendar</button>
        </form>
      )}
      <nav className="calendar-controls" aria-label="Calendar month">
        <Link href={`?month=${previous}${preserveGroup}`} aria-label="Previous month">← Previous</Link>
        <strong>{monthLabel}</strong>
        <Link href={`?month=${next}${preserveGroup}`} aria-label="Next month">Next →</Link>
      </nav>
      <div className="content-calendar" role="grid" aria-label={monthLabel}>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <div key={day} className="calendar-weekday" role="columnheader">{day}</div>
        ))}
        {cells.map((day, index) => {
          const key = day ? `${currentMonth}-${String(day).padStart(2, '0')}` : '';
          const scheduled = day ? entries.get(key) ?? [] : [];
          return (
            <section key={`${key}-${index}`} className={`calendar-day${day ? '' : ' calendar-day-empty'}`} role="gridcell">
              {day && <>
                <time dateTime={key}>{day}</time>
                {scheduled.map((post) => (
                  <Link key={post.id} className="calendar-post" href={`/app/${workspace}/posts#post-${post.id}`}>
                    <span>{post.revisions[0]?.content ?? 'Scheduled post'}</span>
                    <small>{post.destinations.map(({ channel }) => channel.name).join(', ')}</small>
                  </Link>
                ))}
              </>}
            </section>
          );
        })}
      </div>
      <h2>Scheduled agenda</h2>
      {posts.length ? <ul className="post-list">{posts.map((post) => (
        <li key={post.id}>
          {post.scheduledAt && <time dateTime={post.scheduledAt.toISOString()}>{format.format(post.scheduledAt)}</time>}
          <p className="post-content">{post.revisions[0]?.content}</p>
          <p>{post.destinations.map(({ channel, state }) => `#${channel.name} · ${state.toLowerCase()}`).join(', ')}</p>
        </li>
      ))}</ul> : <p>No scheduled posts yet. Approve a draft, then choose an exact time or the next shared posting slot.</p>}
      <Link href={`/app/${workspace}/posts`}>Manage posts</Link>
    </>
  );
}
