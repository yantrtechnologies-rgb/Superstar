import { getProvider, reviewPreview } from '@cadencedesk/data';
import { notFound } from 'next/navigation';
import { reviewResponseAction } from './actions';

export const metadata = { title: 'Client review · Superstar', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function ClientReview({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ token }, { status }] = await Promise.all([params, searchParams]);
  const review = await reviewPreview(token);
  if (!review) notFound();
  return (
    <main className="identity-shell">
      <p className="wordmark">Superstar</p>
      <h1>Client review</h1>
      <p>{review.workspaceName} · Revision {review.revision}</p>
      <article className="review-preview">
        <p className="post-content">{review.content}</p>
        {review.followUpText && <div>
          <p>Discord follow-up · {review.followUpDelayMinutes} minutes after publication</p>
          <p className="post-content">{review.followUpText}</p>
        </div>}
        {review.asset && <img src={`/review/${token}/image`} alt="Image attached to the draft" />}
        <p>{review.channels.map(({ provider, name }) => `${getProvider(provider)?.name ?? provider} · ${name}`).join(', ')}</p>
      </article>
      {review.comments.length > 0 && <section>
        <h2>Feedback</h2>
        <ul className="review-comments">
          {review.comments.map((comment) => (
            <li key={comment.id}>{comment.action === 'APPROVE' ? 'Approved' : comment.action === 'CHANGES' ? 'Requested changes' : 'Client comment'}
              {comment.body && <p className="post-content">{comment.body}</p>}
            </li>
          ))}
        </ul>
      </section>}
      {status === 'invalid' && <p role="status">Enter a comment for feedback or a change request. The revision must still be in review.</p>}
      {review.state === 'IN_REVIEW' ? (
        <form className="identity-form" action={reviewResponseAction}>
          <input type="hidden" name="token" value={token} />
          <label htmlFor="feedback">Feedback</label>
          <textarea id="feedback" name="body" rows={4} maxLength={2000} />
          <button type="submit" name="decision" value="COMMENT">Add comment</button>
          <button type="submit" name="decision" value="CHANGES">Request changes</button>
          <button className="primary" type="submit" name="decision" value="APPROVE">Approve revision</button>
        </form>
      ) : <p role="status">This revision is closed for review.</p>}
    </main>
  );
}
