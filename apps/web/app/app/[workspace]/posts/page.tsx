import { canApprovePosts, canWritePosts, findMembership, getProvider, listChannels, listPosts } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { ReviewLinkForm } from './review-link-form';
import { revokeReviewLinkAction } from '../review-actions';
import { approvePostAction, cancelPostAction, savePostAction, schedulePostAction, submitPostAction } from '../publishing-actions';

const messages: Record<string, string> = {
  saved: 'Post updated.',
  slot: 'No shared time was available in the next five weeks. Change the channel posting slots or choose a time manually.',
  invalid: 'Check the text, UTC time and selected destinations.',
  provider: 'Check destination text and attachment limits. A follow-up needs at least one Discord destination.',
  image: 'Use a PNG or JPEG up to 2 MiB. If the file is valid, ask your operator to check object storage.',
  unavailable: 'That action is unavailable. Check the post status, approval and your workspace access.',
};

function PostFields({ workspace, id, revision }: { workspace: string; id?: string; revision?: number }) {
  return (
    <>
      <input type="hidden" name="workspace" value={workspace} />
      {id && <input type="hidden" name="postId" value={id} />}
      {revision && <input type="hidden" name="revision" value={revision} />}
    </>
  );
}

function FollowUpFields({ id, text, delay }: { id: string; text?: string | null; delay?: number | null }) {
  return (
    <details open={Boolean(text)}>
      <summary>Discord follow-up</summary>
      <div className="identity-form">
        <p>Send a reply after the parent message succeeds.</p>
        <label htmlFor={`reply-${id}`}>Follow-up text</label>
        <textarea id={`reply-${id}`} name="followUpText" rows={3} maxLength={2000} defaultValue={text ?? ''} />
        <label htmlFor={`delay-${id}`}>Delay in minutes</label>
        <input id={`delay-${id}`} name="followUpDelay" type="number" min="1" max="10080" defaultValue={delay ?? 15} />
      </div>
    </details>
  );
}

export default async function Posts({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const membership = await findMembership(user.id, workspace);
  if (!membership) notFound();
  const [posts, channels] = await Promise.all([listPosts(user.id, workspace), listChannels(user.id, workspace)]);
  const canWrite = canWritePosts(membership.role);
  const canApprove = canApprovePosts(membership.role);
  return (
    <>
      <h1>Posts</h1>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {canWrite && (
        <section>
          <h2>New draft</h2>
          <form action={savePostAction} className="identity-form">
            <PostFields workspace={workspace} />
            <label htmlFor="new-content">Post text</label>
            <textarea id="new-content" name="content" maxLength={4096} rows={4} required />
            <label htmlFor="new-image">Optional image (PNG or JPEG, up to 2 MiB)</label>
            <input id="new-image" type="file" name="image" accept="image/png,image/jpeg" />
            <FollowUpFields id="new" />
            <button type="submit">Create draft</button>
          </form>
        </section>
      )}
      {posts.length ? <ul className="post-list">{posts.map((post) => {
        const fields = { workspace, id: post.id, revision: post.revision };
        const content = post.revisions[0]?.content;
        const editable = canWrite && ['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(post.state);
        return (
          <li key={post.id}>
            <article>
              <h2>{post.state.replaceAll('_', ' ').toLowerCase()} · Revision {post.revision}</h2>
              {post.scheduledAt && <p><time dateTime={post.scheduledAt.toISOString()}>{post.scheduledAt.toISOString()}</time></p>}
              {editable ? (
                <form action={savePostAction} className="identity-form">
                  <PostFields {...fields} />
                  <label htmlFor={post.id}>Post text</label>
                  <textarea id={post.id} name="content" maxLength={4096} rows={4} defaultValue={content} required />
                  <label htmlFor={`image-${post.id}`}>Optional replacement image</label>
                  <input id={`image-${post.id}`} type="file" name="image" accept="image/png,image/jpeg" />
                  <FollowUpFields id={post.id} text={post.revisions[0]?.followUpText} delay={post.revisions[0]?.followUpDelayMinutes} />
                  <button type="submit">Save new revision</button>
                </form>
              ) : <p className="post-content">{content}</p>}
              {post.revisions[0]?.followUpText && <div>
                <p>Discord follow-up · {post.revisions[0].followUpDelayMinutes} minutes after publication</p>
                <p className="post-content">{post.revisions[0].followUpText}</p>
              </div>}
              {post.revisions[0]?.asset && <p>Attached image · {post.revisions[0].asset.type}</p>}
              {post.revisions[0]?.channelIds.length ? (
                <p>Destinations: {channels.filter(({ id }) => post.revisions[0]?.channelIds.includes(id))
                  .map(({ name }) => '#' + name).join(', ')}</p>
              ) : null}
              {canWrite && post.state === 'DRAFT' && channels.length > 0 && (
                                <form action={submitPostAction} className="identity-form">
                  <PostFields {...fields} />
                  <fieldset>
                    <legend>Destinations</legend>
                    {channels.map((channel) => {
                      const adapter = getProvider(channel.provider);
                      return (
                        <label key={channel.id} className="channel-choice">
                          <input type="checkbox" name="channel" value={channel.id} disabled={!adapter} />
                          #{channel.name}
                          {!adapter && <small className="block">Publishing support is pending for this connection.</small>}
                          {adapter && <small className="block">{
                            `${adapter.name} · ${adapter.textLimit} characters · ${adapter.imageCaptionLimit
                              ? `${adapter.imageCaptionLimit} with image` : 'text only'}`
                          }</small>}
                        </label>
                      );
                    })}
                  </fieldset>
                  <button type="submit">Request approval</button>
                </form>
              )}
              {canWrite && post.state === 'DRAFT' && !channels.length && (
                <Link href={`/app/${workspace}/channels`}>Connect a channel before requesting approval</Link>
              )}
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
              {canApprove && post.state === 'IN_REVIEW' && (
                <form action={approvePostAction}><PostFields {...fields} /><button type="submit">Approve revision</button></form>
              )}
              {canWrite && post.state === 'APPROVED' && (channels.length ? (
                <form action={schedulePostAction} className="identity-form">
                  <PostFields {...fields} />
                  {post.revisions[0]?.channelIds.map((id) => <input key={id} type="hidden" name="channel" value={id} />)}
                  <label htmlFor={`due-${post.id}`}>Schedule time (UTC)</label>
                  <input type="datetime-local" id={`due-${post.id}`} name="dueAt" />
                  <button type="submit" name="mode" value="schedule">Schedule</button>
                  <button type="submit" name="mode" value="next">Use next shared slot</button>
                  <button type="submit" name="mode" value="now">Publish now</button>
                </form>
              ) : <Link href={`/app/${workspace}/channels`}>Connect a channel to schedule this post</Link>)}
              {post.destinations.length > 0 && (
                <ul className="workspaces-list">
                  {post.destinations.map((destination) => (
                    <li key={destination.id}>
                      <span>#{destination.channel.name} · {destination.state.toLowerCase()}{destination.parentId ? ' · follow-up' : ''}</span>
                      {destination.error && <p>{destination.error}</p>}
                      {destination.permalink && <a href={destination.permalink}>Open in {getProvider(destination.channel.provider)?.name ?? 'provider'}</a>}
                    </li>
                  ))}
                </ul>
              )}
              {canWrite && post.destinations.some(({ state }) => state === 'SCHEDULED') && (
                <form action={cancelPostAction}><PostFields {...fields} /><button type="submit">Cancel pending destinations</button></form>
              )}
            </article>
          </li>
        );
      })}</ul> : <p>No posts yet.</p>}
    </>
  );
}
