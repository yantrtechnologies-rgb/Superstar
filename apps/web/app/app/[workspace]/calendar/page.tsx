import { canManageTeam, canWritePosts, listChannels, listChannelSettings, listPosts } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { CalendarDrag } from './calendar-drag';

const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const dayPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const views = ['day', 'week', 'month', 'list'] as const;
type View = (typeof views)[number];

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { key: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour) };
}

const utc = (key: string) => new Date(key + 'T00:00:00Z');
const keyOf = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

export default async function Calendar({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ group?: string; month?: string; view?: string; week?: string; day?: string }>;
}) {
  const user = await requireUser();
  const { workspace } = await params;
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  const [{ group, month, view: rawView, week, day }, settings, channels] = await Promise.all([
    searchParams, listChannelSettings(user.id, workspace), listChannels(user.id, workspace),
  ]);
  const groups = settings?.clientGroups ?? [];
  const selected = groups.find(({ id }) => id === group)?.id;
  const posts = await listPosts(user.id, workspace, true, selected);
  const timeZone = membership.workspace.timeZone;
  const time = new Intl.DateTimeFormat('en', { timeStyle: 'short', timeZone });
  const longDay = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const today = zonedParts(new Date(), timeZone).key;
  const view: View = (views as readonly string[]).includes(rawView ?? '') ? rawView as View : 'month';
  const groupQuery = selected ? `&group=${encodeURIComponent(selected)}` : '';
  const canMove = canWritePosts(membership.role);
  const base = `/app/${workspace}`;

  const entries = new Map<string, typeof posts>();
  for (const post of posts) {
    if (!post.scheduledAt) continue;
    const key = zonedParts(post.scheduledAt, timeZone).key;
    entries.set(key, [...(entries.get(key) ?? []), post]);
  }

  let cells: (string | null)[] = [];
  let label = '';
  let previousHref = '';
  let nextHref = '';
  let currentMonth = today.slice(0, 7);
  let anchorDay = today;
  if (view === 'day') {
    anchorDay = dayPattern.test(day ?? '') ? day! : today;
    label = longDay.format(utc(anchorDay)) + ', ' + anchorDay.slice(0, 4);
    previousHref = `?view=day&day=${keyOf(addDays(utc(anchorDay), -1))}${groupQuery}`;
    nextHref = `?view=day&day=${keyOf(addDays(utc(anchorDay), 1))}${groupQuery}`;
    currentMonth = anchorDay.slice(0, 7);
  } else if (view === 'week') {
    const anchor = utc(dayPattern.test(week ?? '') ? week! : today);
    const start = addDays(anchor, -anchor.getUTCDay());
    cells = Array.from({ length: 7 }, (_, index) => keyOf(addDays(start, index)));
    const end = addDays(start, 6);
    const short = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    label = `${short.format(start)} – ${short.format(end)}, ${end.getUTCFullYear()}`;
    previousHref = `?view=week&week=${keyOf(addDays(start, -7))}${groupQuery}`;
    nextHref = `?view=week&week=${keyOf(addDays(start, 7))}${groupQuery}`;
    currentMonth = keyOf(start).slice(0, 7);
  } else if (view === 'month') {
    currentMonth = monthPattern.test(month ?? '') ? month! : today.slice(0, 7);
    const year = Number(currentMonth.slice(0, 4));
    const monthNumber = Number(currentMonth.slice(5, 7));
    const first = new Date(Date.UTC(year, monthNumber - 1, 1));
    const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const leading = first.getUTCDay();
    cells = Array.from({ length: Math.ceil((leading + days) / 7) * 7 }, (_, index) => {
      const value = index - leading + 1;
      return value >= 1 && value <= days ? `${currentMonth}-${String(value).padStart(2, '0')}` : null;
    });
    label = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
    previousHref = `?month=${new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7)}${groupQuery}`;
    nextHref = `?month=${new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7)}${groupQuery}`;
  } else {
    label = 'Upcoming';
  }

  function stateOf(post: (typeof posts)[number]) {
    const states = post.destinations.filter(({ parentId }) => !parentId).map(({ state }) => state);
    return states.find((value) => ['FAILED', 'UNCERTAIN'].includes(value))
      ?? (states.includes('PUBLISHING') ? 'PUBLISHING' : states.length && states.every((value) => value === 'PUBLISHED') ? 'PUBLISHED' : 'SCHEDULED');
  }

  function Chip({ post, showDate }: { post: (typeof posts)[number]; showDate?: boolean }) {
    const state = stateOf(post);
    const parts = zonedParts(post.scheduledAt!, timeZone);
    const movable = canMove && post.state === 'SCHEDULED'
      && post.destinations.filter(({ parentId }) => !parentId).every(({ state: s }) => s === 'SCHEDULED' || s === 'CANCELED');
    const tag = post.tags[0]?.tag;
    const text = post.revisions[0]?.content ?? 'Scheduled post';
    return (
      <Link
        className={`calendar-post state-${state.toLowerCase()}${movable ? ' movable' : ''}`}
        href={`${base}/posts#post-${post.id}`}
        title={text}
        style={tag ? { ['--tag' as string]: tag.color } : undefined}
        draggable={movable}
        {...(movable ? { 'data-post-id': post.id, 'data-at': post.scheduledAt!.toISOString(), 'data-date': parts.key, 'data-hour': String(parts.hour) } : {})}
      >
        <b>{showDate ? `${parts.key.slice(5)} · ` : ''}{time.format(post.scheduledAt!)}{post.repeatEveryDays ? ' ↻' : ''}</b>
        <span>{text}</span>
        <small>{post.destinations.filter(({ parentId }) => !parentId).map(({ channel }) => channel.name).join(', ')}</small>
      </Link>
    );
  }

  const viewHref = (target: View) => target === 'month' ? `?month=${currentMonth}${groupQuery}`
    : target === 'week' ? `?view=week&week=${anchorDay}${groupQuery}`
    : target === 'day' ? `?view=day&day=${view === 'day' ? anchorDay : today}${groupQuery}` : `?view=list${groupQuery}`;
  const todayHref = view === 'day' ? `?view=day${groupQuery}` : view === 'week' ? `?view=week${groupQuery}` : `?month=${today.slice(0, 7)}${groupQuery}`;
  const upcoming = posts.filter((post) => post.scheduledAt && post.scheduledAt.getTime() > Date.now() - 86_400_000);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Calendar</h1>
          <p>Scheduled publishing in {timeZone}.{canMove ? ' Drag a scheduled post to move it.' : ''}</p>
        </div>
        {canMove && <Link className="btn btn-primary" href={`${base}/posts/new`}>+ Create post</Link>}
      </header>
      <div className="calendar-layout">
        <aside className="calendar-channels" aria-label="Connected channels">
          <h2>Channels</h2>
          {channels.length ? (
            <ul>
              {channels.map((channel) => (
                <li key={channel.id} title={channel.name}>
                  <span className="channel-avatar" data-provider={channel.provider} aria-hidden="true">{channel.name.slice(0, 1)}</span>
                  <span>{channel.name}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted-line">No channels yet.</p>}
          {canManageTeam(membership.role) && <Link className="btn" href={`${base}/channels`}>+ Add channel</Link>}
        </aside>
        <div>
          <div className="calendar-toolbar">
            {view !== 'list' ? (
              <nav className="calendar-nav" aria-label="Calendar period">
                <Link href={previousHref} aria-label={`Previous ${view}`}>‹</Link>
                <Link href={todayHref}>Today</Link>
                <Link href={nextHref} aria-label={`Next ${view}`}>›</Link>
                <strong>{label}</strong>
              </nav>
            ) : <strong>Upcoming posts</strong>}
            {groups.length > 0 && (
              <form className="calendar-filter" method="get">
                <label htmlFor="group" className="sr-only">Client group</label>
                <select id="group" name="group" defaultValue={selected ?? ''}>
                  <option value="">All client groups</option>
                  {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                {view !== 'month' && <input type="hidden" name="view" value={view} />}
                {view === 'month' && <input type="hidden" name="month" value={currentMonth} />}
                {view === 'week' && week && <input type="hidden" name="week" value={week} />}
                {view === 'day' && <input type="hidden" name="day" value={anchorDay} />}
                <button type="submit">Apply</button>
              </form>
            )}
            <nav className="segmented" aria-label="Calendar view">
              {views.map((item) => (
                <Link key={item} href={viewHref(item)} aria-current={view === item ? 'page' : undefined}>{item[0]!.toUpperCase() + item.slice(1)}</Link>
              ))}
            </nav>
          </div>

          <CalendarDrag workspace={workspace}>
            {view === 'day' && (
              <div className="day-view" role="grid" aria-label={label}>
                {Array.from({ length: 24 }, (_, hour) => {
                  const items = (entries.get(anchorDay) ?? []).filter((post) => zonedParts(post.scheduledAt!, timeZone).hour === hour);
                  return (
                    <div key={hour} className="day-hour" role="row" data-date={anchorDay} data-hour={hour}>
                      <time>{String(hour).padStart(2, '0')}:00</time>
                      <div className="day-hour-posts">{items.map((post) => <Chip key={post.id} post={post} />)}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {(view === 'week' || view === 'month') && (
              <div className={`content-calendar ${view}`} role="grid" aria-label={label}>
                {weekdays.map((name, index) => (
                  <div key={name} className={`calendar-weekday${view === 'week' && cells[index] === today ? ' today' : ''}`} role="columnheader">
                    {name}{view === 'week' && cells[index] && <b>{Number(cells[index]!.slice(8))}</b>}
                  </div>
                ))}
                {cells.map((key, index) => (
                  <section key={`${key}-${index}`} className={`calendar-day${key ? '' : ' calendar-day-empty'}${key === today ? ' today' : ''}`}
                    role="gridcell" {...(key ? { 'data-date': key } : {})}>
                    {key && <>
                      {view === 'month' && <Link className="day-link" href={`?view=day&day=${key}${groupQuery}`}><time dateTime={key}>{Number(key.slice(8))}</time></Link>}
                      {(entries.get(key) ?? []).map((post) => <Chip key={post.id} post={post} />)}
                    </>}
                  </section>
                ))}
              </div>
            )}
            {view === 'list' && (
              upcoming.length ? (
                <ol className="calendar-list">
                  {upcoming.map((post) => <li key={post.id}><Chip post={post} showDate /></li>)}
                </ol>
              ) : <p className="muted-line">Nothing scheduled from today on.</p>
            )}
          </CalendarDrag>

          <div className="calendar-legend" aria-label="Status colours">
            <span className="badge badge-muted" style={{ color: 'var(--accent-text)' }}>Scheduled</span>
            <span className="badge badge-warn">Publishing</span>
            <span className="badge badge-ok">Published</span>
            <span className="badge badge-bad">Needs attention</span>
            <span className="badge badge-muted">↻ Repeats</span>
          </div>
          {!posts.length && <p className="muted-line">No scheduled posts yet. <Link href={`${base}/posts/new`}>Create a post</Link> and schedule it.</p>}
        </div>
      </div>
    </>
  );
}
