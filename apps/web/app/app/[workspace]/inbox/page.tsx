import { canWritePosts, commentInbox, type InboxComment } from '@cadencedesk/data';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { replyAction } from './actions';

export const dynamic = 'force-dynamic';

const networkNames = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube' } as const;
const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function ReplyForm({ workspace, destinationId, commentId, author }: { workspace: string; destinationId: string; commentId: string; author: string }) {
  return (
    <details className="inbox-reply">
      <summary>Reply</summary>
      <form action={replyAction} className="identity-form">
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="destinationId" value={destinationId} />
        <input type="hidden" name="commentId" value={commentId} />
        <label htmlFor={`reply-${commentId}`}>Reply to {author}</label>
        <textarea id={`reply-${commentId}`} name="message" rows={3} maxLength={2000} required />
        <button type="submit" className="primary">Send reply</button>
      </form>
    </details>
  );
}

function Comment({ comment, children }: { comment: InboxComment; children?: ReactNode }) {
  return (
    <div className="inbox-comment">
      <p className="inbox-meta"><strong>{comment.author}</strong>{comment.createdAt && <> · <time dateTime={comment.createdAt}>{when.format(new Date(comment.createdAt))}</time></>}</p>
      <p className="inbox-text">{comment.text || <em>(no text)</em>}</p>
      {children}
    </div>
  );
}

export default async function Inbox({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string; message?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status, message }] = await Promise.all([params, searchParams]);
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  const canReply = canWritePosts(membership.role);
  const posts = await commentInbox(user.id, workspace);
  const total = posts.reduce((n, p) => n + p.comments.length + p.comments.reduce((m, c) => m + c.replies.length, 0), 0);

  return (
    <>
      <h1>Inbox</h1>
      <p>Comments on posts you published from Superstar in the last 30 days, from Facebook Pages, Instagram and YouTube. Replies are posted as your Page, account or channel.</p>
      {status === 'replied' && <p role="status">Reply posted.</p>}
      {status === 'invalid' && <p role="status" className="status-error">Write a reply first.</p>}
      {status === 'error' && message && <p role="status" className="status-error">{message}</p>}
      <p className="muted-line">
        {posts.length ? `${total} comment${total === 1 ? '' : 's'} across ${posts.length} post${posts.length === 1 ? '' : 's'}. ` : ''}
        LinkedIn, X and Telegram comments aren&apos;t available yet: those networks don&apos;t let apps like Superstar read them without extra approval.
        {' '}<Link href={`/app/${workspace}/inbox`}>Refresh</Link>
      </p>
      {!posts.length && (
        <section className="panel"><p>No published Facebook, Instagram or YouTube posts in the last 30 days. Publish a post, and its comments will show up here.</p></section>
      )}
      <ul className="inbox-list">
        {posts.map((post) => (
          <li key={post.destinationId} className="inbox-post">
            <header>
              <span className="channel-avatar" data-provider={post.provider} aria-hidden="true">{networkNames[post.provider].slice(0, 1)}</span>
              <div>
                <strong>{post.channelName}</strong> <span className="muted-line">· {networkNames[post.provider]}{post.publishedAt && <> · {when.format(new Date(post.publishedAt))}</>}</span>
                <p className="inbox-excerpt">{post.excerpt || <em>(media post)</em>}</p>
              </div>
              {post.permalink && <a href={post.permalink} target="_blank" rel="noreferrer">View post</a>}
            </header>
            {post.error ? <p className="status-error" role="status">{post.error}</p>
              : post.comments.length === 0 ? <p className="muted-line">No comments yet.</p>
              : post.comments.map((comment) => (
                <Comment key={comment.id} comment={comment}>
                  {comment.replies.length > 0 && (
                    <div className="inbox-replies">
                      {comment.replies.map((reply) => <Comment key={reply.id} comment={reply} />)}
                    </div>
                  )}
                  {canReply && <ReplyForm workspace={workspace} destinationId={post.destinationId} commentId={comment.id} author={comment.author} />}
                </Comment>
              ))}
          </li>
        ))}
      </ul>
    </>
  );
}
