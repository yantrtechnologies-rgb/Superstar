'use client';

import { useActionState, useId } from 'react';
import { saveWebhookSecretAction } from './actions';

export function WebhookSecretForm({ workspace, id }: { workspace: string; id?: string }) {
  const [result, action, pending] = useActionState(saveWebhookSecretAction, { secret: '', message: '' });
  const formId = useId();
  return (
    <form action={action} className="identity-form">
      <input type="hidden" name="workspace" value={workspace} />
      {id ? <input type="hidden" name="id" value={id} /> : <>
        <label htmlFor={formId + '-name'}>Subscription name</label>
        <input id={formId + '-name'} name="name" required maxLength={80} />
        <label htmlFor={formId + '-endpoint'}>Approved HTTPS endpoint</label>
        <input id={formId + '-endpoint'} name="endpoint" type="url" required maxLength={2048} />
      </>}
      <button type="submit" disabled={pending}>{pending ? 'Saving…' : id ? 'Rotate signing secret' : 'Create webhook'}</button>
      {result.message && <p role="status">{result.message}</p>}
      {result.secret && <div>
        <label htmlFor={formId + '-secret'}>Signing secret</label>
        <input id={formId + '-secret'} value={result.secret} readOnly autoComplete="off" onFocus={(event) => event.target.select()} />
        <p>Copy this secret now. It is shown here once.</p>
      </div>}
    </form>
  );
}
