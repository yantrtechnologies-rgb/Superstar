'use client';

import { useActionState, useId } from 'react';
import { issueReviewLinkAction } from '../review-actions';

export function ReviewLinkForm({ workspace, postId, revision }: { workspace: string; postId: string; revision: number }) {
  const [result, action, pending] = useActionState(issueReviewLinkAction, { url: '', message: '' });
  const id = useId();
  return (
    <form action={action} className="identity-form">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="revision" value={revision} />
      <label htmlFor={id}>Review link expiration</label>
      <select id={id} name="days" defaultValue="7">
        <option value="1">1 day</option>
        <option value="7">7 days</option>
        <option value="14">14 days</option>
      </select>
      <button type="submit" disabled={pending}>{pending ? 'Creating link…' : 'Create client review link'}</button>
      {result.message && <p role="status">{result.message}</p>}
      {result.url && <div>
        <label htmlFor={id + '-link'}>Shareable review link</label>
        <input id={id + '-link'} value={result.url} readOnly onFocus={(event) => event.target.select()} />
        <p>Copy this link now. Anyone with it can review this revision until it expires or is revoked.</p>
      </div>}
    </form>
  );
}
