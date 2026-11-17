import { canApprovePosts, canWritePosts, findMembership, getProvider, listChannels, listPosts } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { approvePostAction, cancelPostAction, savePostAction, schedulePostAction, submitPostAction } from '../publishing-actions';

const messages: Record<string, string> = {
  saved: 'Post updated.',
  invalid: 'Check the text, UTC time and selected destinations.',
  provider: 'Check the text length and attachment limits for every selected destination.',
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
                  <button type="submit">Save new revision</button>
                </form>
              ) : <p className="post-content">{content}</p>}
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
                          <input type="checkbox" name="channel" value={channel.id} />
                          #{channel.name}
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
                  <button type="submit" name="mode" value="now">Publish now</button>
                </form>
              ) : <Link href={`/app/${workspace}/channels`}>Connect a channel to schedule this post</Link>)}
              {post.destinations.length > 0 && (
                <ul className="workspaces-list">
                  {post.destinations.map((destination) => (
                    <li key={destination.id}>
                      <span>#{destination.channel.name} · {destination.state.toLowerCase()}</span>
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
