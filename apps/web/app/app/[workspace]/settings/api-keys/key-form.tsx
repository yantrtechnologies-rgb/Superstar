'use client';

import { apiScopes } from '@cadencedesk/contracts';
import { useActionState } from 'react';
import { createKeyAction } from './actions';

const descriptions = {
  'channels:read': 'List workspace channels',
  'posts:read': 'Read posts and destination results',
  'posts:write': 'Create drafts and request review',
  'posts:schedule': 'Schedule approved posts and cancel pending destinations',
};

export function KeyForm({ workspace }: { workspace: string }) {
  const [result, action, pending] = useActionState(createKeyAction, { token: '', message: '' });
  return (
    <form action={action} className="identity-form">
      <input type="hidden" name="workspace" value={workspace} />
      <label htmlFor="key-name">Key name</label>
      <input id="key-name" name="name" maxLength={80} required />
      <label htmlFor="key-expiration">Key expiration</label>
      <select id="key-expiration" name="days" defaultValue="30">
        <option value="7">7 days</option>
        <option value="30">30 days</option>
        <option value="90">90 days</option>
      </select>
      <fieldset>
        <legend>Access scopes</legend>
        {apiScopes.map((scope) => <label key={scope} className="channel-choice">
          <input type="checkbox" name="scope" value={scope} /> {descriptions[scope]}
        </label>)}
      </fieldset>
      <button type="submit" disabled={pending}>{pending ? 'Creating key…' : 'Create API key'}</button>
      {result.message && <p role="status">{result.message}</p>}
      {result.token && <div>
        <label htmlFor="key-secret">New API key</label>
        <input id="key-secret" value={result.token} readOnly autoComplete="off" onFocus={(event) => event.target.select()} />
        <p>Copy the key now. It is shown here once.</p>
      </div>}
    </form>
  );
}
