import { canWritePosts, listReminders } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { mediaTypes, MediaThumb } from '../post-media';
import { confirmReminderAction } from './actions';
import { CopyText } from './copy-text';

export const dynamic = 'force-dynamic';

const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const messages: Record<string, [string, boolean]> = {
  posted: ['Marked as posted.', false],
  link: ['That post link doesn\'t look right. Paste the full https:// address, or leave it empty.', true],
  unavailable: ['That reminder could not be updated.', true],
};

export default async function Reminders({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  const canWrite = canWritePosts(membership.role);
  const reminders = await listReminders(user.id, workspace);
  const types = await mediaTypes(reminders.flatMap(({ mediaIds }) => mediaIds));
  const base = `/app/${workspace}`;
  const open = reminders.filter(({ confirmedAt }) => !confirmedAt);
  const done = reminders.filter(({ confirmedAt }) => confirmedAt);
  const message = status ? messages[status] : undefined;

  return (
    <>
      <h1>Reminders</h1>
      <p>
        Posts for places no app can post to, such as Facebook profiles and Groups. When one is due, Superstar emails it to the
        person on its reminder channel. Copy the text, download the media, post it yourself, then mark it as posted.
      </p>
      {message && <p role="status" className={message[1] ? 'status-error' : undefined}>{message[0]}</p>}
      {!reminders.length && (
        <section className="panel">
          <p>No reminders yet. Add a reminder channel on <Link href={`${base}/channels#reminder-channel`}>Channels</Link>, then choose it when you schedule a post.</p>
        </section>
      )}
      {open.length > 0 && <h2>To post ({open.length})</h2>}
      <ul className="reminder-list">
        {open.map((item) => (
          <li key={item.id} id={`reminder-${item.id}`} className="panel reminder">
            <header>
              <strong>{item.channelName}</strong>
              <span className="muted-line"> · {item.network.name}{item.sentAt && <> · reminded {when.format(item.sentAt)}</>}</span>
            </header>
            <CopyText text={item.text} label={`Text to post on ${item.channelName}`} />
            {item.mediaIds.length > 0 && (
              <div className="media-strip small">
                {item.mediaIds.map((id, index) => (
                  <figure key={id}>
                    <MediaThumb src={`${base}/media/${id}`} type={types.get(id)} />
                    <a href={`${base}/media/${id}?download=1`} download>Download {types.get(id) === 'video/mp4' ? 'video' : 'image'} {item.mediaIds.length > 1 ? index + 1 : ''}</a>
                  </figure>
                ))}
              </div>
            )}
            <div className="post-actions">
              {item.network.open && <a className="btn" href={item.network.open} target="_blank" rel="noreferrer">Open {item.network.name}</a>}
            </div>
            {canWrite && (
              <form action={confirmReminderAction} className="identity-form">
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="destinationId" value={item.id} />
                <label htmlFor={`link-${item.id}`}>Link to the post (optional)</label>
                <input id={`link-${item.id}`} name="link" type="url" maxLength={500} placeholder="https://www.facebook.com/..." />
                <button type="submit" className="primary">Mark as posted</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {done.length > 0 && (
        <details>
          <summary>Posted ({done.length})</summary>
          <ul className="review-comments">
            {done.map((item) => (
              <li key={item.id}>
                <strong>{item.channelName}</strong> <span className="muted-line">· {item.network.name} · posted {when.format(item.confirmedAt!)}</span>
                {item.permalink && <> · <a href={item.permalink} target="_blank" rel="noreferrer">View post</a></>}
                <p className="post-content">{item.text.slice(0, 200)}{item.text.length > 200 ? '…' : ''}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
