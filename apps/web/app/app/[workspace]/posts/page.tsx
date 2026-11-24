import {
  canApprovePosts, canWritePosts, getProvider, listChannels, listPosts, revisionMediaIds, revisionOverrides, revisionThread,
} from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { ReviewLinkForm } from './review-link-form';
import { revokeReviewLinkAction } from '../review-actions';
import { approvePostAction, cancelPostAction, schedulePostAction } from '../publishing-actions';
import { cancelDestinationAction, duplicateAction } from './composer-actions';

const messages: Record<string, string> = {
  saved: 'Post updated.',
  draft: 'Draft saved.',
  in_review: 'Submitted for approval.',
  'channel-canceled': 'That channel was removed from the post. The other channels still publish.',
  slot: 'No shared time was available in the next five weeks. Change the channel posting slots or choose a time manually.',
  invalid: 'Check the text, time and selected destinations.',
  provider: 'Check destination text and attachment limits.',
  image: 'Use a PNG or JPEG up to 2 MiB. If the file is valid, ask your operator to check object storage.',
  unavailable: 'That action is unavailable. Check the post status, approval and your workspace access.',
};

const filters = [
  ['', 'All'], ['DRAFT', 'Drafts'], ['IN_REVIEW', 'In review'], ['APPROVED', 'Approved'], ['SCHEDULED', 'Scheduled'],
  ['PUBLISHED', 'Published'], ['FAILED', 'Failed'], ['CANCELED', 'Canceled'],
] as const;

/**
 * A post stays SCHEDULED in the database after it goes out, so the list derives what people expect to see:
 * Published once every channel is published, Failed when any channel failed, otherwise the stored state.
 */
function viewState(post: { state: string; destinations: { parentId: string | null; state: string }[] }) {
  if (post.state !== 'SCHEDULED') return post.state;
  const roots = post.destinations.filter(({ parentId }) => !parentId);
  if (roots.some(({ state }) => state === 'FAILED')) return 'FAILED';
  if (roots.length && roots.every(({ state }) => state === 'PUBLISHED' || state === 'CANCELED')
    && roots.some(({ state }) => state === 'PUBLISHED')) return 'PUBLISHED';
  return 'SCHEDULED';
}

function Hidden({ workspace, id, revision }: { workspace: string; id?: string; revision?: number }) {
  return (
    <>
      <input type="hidden" name="workspace" value={workspace} />
      {id && <input type="hidden" name="postId" value={id} />}
      {revision && <input type="hidden" name="revision" value={revision} />}
    </>
  );
}

export default async function Posts({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; state?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status, state }] = await Promise.all([params, searchParams]);
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  const [allPosts, channels] = await Promise.all([listPosts(user.id, workspace), listChannels(user.id, workspace)]);
  const posts = state ? allPosts.filter((post) => viewState(post) === state) : allPosts;
  const canWrite = canWritePosts(membership.role);
  const canApprove = canApprovePosts(membership.role);
  const earliestSchedule = new Date(Date.now() + 60_000).toISOString().slice(0, 16);
  const format = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone });
  const base = `/app/${workspace}`;
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Posts</h1>
          <p>Drafts, approvals and everything scheduled. Times shown in {membership.workspace.timeZone}.</p>
        </div>
        {canWrite && <Link className="btn btn-primary" href={`${base}/posts/new`}>+ Create post</Link>}
      </header>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      <nav className="segmented" aria-label="Filter posts">
        {filters.map(([value, label]) => (
          <Link key={label} href={value ? `?state=${value}` : '?'} aria-current={(state ?? '') === value ? 'page' : undefined}>
            {label} <small>{value ? allPosts.filter((post) => viewState(post) === value).length : allPosts.length}</small>
          </Link>
        ))}
      </nav>
      {posts.length ? <ul className="post-list">{posts.map((post) => {
        const fields = { workspace, id: post.id, revision: post.revision };
        const latest = post.revisions[0];
        const overrides = latest ? revisionOverrides(latest.overrides) : {};
        const thread = latest ? revisionThread(latest) : [];
        const mediaIds = latest ? revisionMediaIds(latest) : [];
        const editable = canWrite && ['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(post.state);
        const roots = post.destinations.filter(({ parentId }) => !parentId);
        return (
          <li key={post.id}>
            <article id={`post-${post.id}`}>
              <h2 className="post-head">
                <span className={'badge ' + (({ SCHEDULED: 'badge-ok', PUBLISHED: 'badge-ok', APPROVED: 'badge-ok', IN_REVIEW: 'badge-warn', FAILED: 'badge-bad', CANCELED: 'badge-bad' } as Record<string, string>)[viewState(post)] ?? 'badge-muted')}>{viewState(post).replaceAll('_', ' ').toLowerCase()}</span><span className="sr-only"> · </span><small>Revision {post.revision}</small>
                {post.repeatEveryDays && <small>· repeats every {post.repeatEveryDays} day{post.repeatEveryDays > 1 ? 's' : ''}</small>}
                {post.tags.map(({ tag }) => <span key={tag.id} className="chip static" style={{ ['--tag' as string]: tag.color }}>{tag.name}</span>)}
              </h2>
              {post.scheduledAt && <p><time dateTime={post.scheduledAt.toISOString()}>{format.format(post.scheduledAt)}</time></p>}
              <p className="post-content">{latest?.content}</p>
              {Object.keys(overrides).length > 0 && (
                <details>
                  <summary>Custom text for {Object.keys(overrides).length} channel{Object.keys(overrides).length > 1 ? 's' : ''}</summary>
                  <ul className="review-comments">
                    {Object.entries(overrides).map(([id, text]) => (
                      <li key={id}><strong>{channels.find((channel) => channel.id === id)?.name ?? 'Channel'}</strong><p className="post-content">{text}</p></li>
                    ))}
                  </ul>
                </details>
              )}
              {mediaIds.length > 0 && (
                <div className="media-strip small">
                  {mediaIds.slice(0, 6).map((id) => <img key={id} src={`${base}/media/${id}`} alt="" loading="lazy" />)}
                </div>
              )}
              {thread.length > 0 && (
                <details>
                  <summary>Thread · {thread.length} item{thread.length > 1 ? 's' : ''}</summary>
                  <ol className="review-comments">
                    {thread.map((item, index) => <li key={index}><span className="muted-line">after {item.delayMinutes} min</span><p className="post-content">{item.content}</p></li>)}
                  </ol>
                </details>
              )}
              {latest?.channelIds.length ? (
                <p className="muted-line">Channels: {channels.filter(({ id }) => latest.channelIds.includes(id)).map(({ name }) => name).join(', ')}</p>
              ) : null}

              <div className="post-actions">
                {editable && <Link className="btn" href={`${base}/posts/${post.id}/edit`}>Edit</Link>}
                {canWrite && (
                  <form action={duplicateAction}><Hidden workspace={workspace} id={post.id} /><button type="submit" className="btn">Duplicate</button></form>
                )}
                {canApprove && post.state === 'IN_REVIEW' && (
                  <form action={approvePostAction}><Hidden {...fields} /><button type="submit" className="btn btn-primary">Approve revision</button></form>
                )}
                {canWrite && roots.some(({ state: s }) => s === 'SCHEDULED') && (
                  <form action={cancelPostAction}><Hidden {...fields} /><button type="submit" className="btn">Cancel all pending</button></form>
                )}
              </div>

              {canWrite && post.state === 'IN_REVIEW' && (
                <ReviewLinkForm key={post.revision} workspace={workspace} postId={post.id} revision={post.revision} />
              )}
              {canWrite && post.reviewLinks.some((link) => link.revision === post.revision && !link.revokedAt && link.expiresAt > new Date()) && (
                <ul className="workspaces-list" aria-label="Review links">
                  {post.reviewLinks.filter((link) => link.revision === post.revision && !link.revokedAt && link.expiresAt > new Date()).map((link) => (
                    <li key={link.id}>
                      <span>Revision {link.revision} · Expires {link.expiresAt.toISOString().slice(0, 10)}</span>
                      <form action={revokeReviewLinkAction}>
                        <input type="hidden" name="workspace" value={workspace} />
                        <input type="hidden" name="linkId" value={link.id} />
                        <button type="submit">Revoke review link</button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              {post.editorialComments.length > 0 && (
                <ul className="review-comments" aria-label="Client feedback">
                  {post.editorialComments.map((comment) => (
                    <li key={comment.id}>
                      <span>Revision {comment.revision} · {comment.action === 'APPROVE' ? 'Client approved'
                        : comment.action === 'CHANGES' ? 'Client requested changes' : 'Client comment'}</span>
                      {comment.body && <p className="post-content">{comment.body}</p>}
                    </li>
                  ))}
                </ul>
              )}
              {canWrite && post.state === 'APPROVED' && (channels.length ? (
                <form action={schedulePostAction} className="identity-form schedule-panel">
                  <Hidden {...fields} />
                  {latest?.channelIds.map((id) => <input key={id} type="hidden" name="channel" value={id} />)}
                  <h3>Schedule</h3>
                  <p>Times are entered in UTC and displayed in {membership.workspace.timeZone} on the calendar.</p>
                  <label htmlFor={`due-${post.id}`}>Schedule date and time (UTC)</label>
                  <input type="datetime-local" id={`due-${post.id}`} name="dueAt" min={earliestSchedule} />
                  <div className="post-actions">
                    <button type="submit" name="mode" value="schedule" className="btn btn-primary">Schedule post</button>
                    <button type="submit" name="mode" value="next" className="btn">Use next shared slot</button>
                    <button type="submit" name="mode" value="now" className="btn">Publish now</button>
                  </div>
                </form>
              ) : <Link href={`${base}/channels`}>Connect a channel to schedule this post</Link>)}
              {post.destinations.length > 0 && (
                <ul className="workspaces-list">
                  {post.destinations.map((destination) => (
                    <li key={destination.id}>
                      <span>{destination.channel.name} · {destination.state.toLowerCase()}{destination.parentId ? ` · thread item ${Math.max(1, destination.threadIndex)}` : ''}</span>
                      {destination.error && <p>{destination.error}</p>}
                      {destination.permalink && <a href={destination.permalink} target="_blank" rel="noreferrer">Open in {getProvider(destination.channel.provider)?.name ?? 'provider'}</a>}
                      {canWrite && !destination.parentId && destination.state === 'SCHEDULED' && roots.length > 1 && (
                        <form action={cancelDestinationAction}>
                          <input type="hidden" name="workspace" value={workspace} />
                          <input type="hidden" name="destinationId" value={destination.id} />
                          <button type="submit" className="btn">Remove this channel</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </li>
        );
      })}</ul> : (
        <section className="panel">
          <p>{state ? 'No posts in this view.' : 'No posts yet.'} {canWrite && <Link href={`${base}/posts/new`}>Create your first post</Link>}</p>
        </section>
      )}
    </>
  );
}
