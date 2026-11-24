import { canManageTeam, listApiKeys } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../../lib/require-user';
import { revokeKeyAction } from './actions';
import { KeyForm } from './key-form';

function apiDocs() {
  if (!process.env.API_PUBLIC_URL) return null;
  try {
    const url = new URL(process.env.API_PUBLIC_URL.replace(/\/+$/, '') + '/docs');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export default async function ApiKeys({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const membership = await getMembership(user.id, workspace);
  if (!membership || !canManageTeam(membership.role)) notFound();
  const keys = await listApiKeys(user.id, workspace);
  const docs = apiDocs();
  const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: membership.workspace.timeZone });
  return (
    <>
      <Link href={`/app/${workspace}/settings`}>Back to team settings</Link>
      <h1>Workspace API keys</h1>
      <p>Use an API key as a bearer token for this workspace.</p>
      {docs && <a href={docs}>Open API documentation</a>}
      {status === 'revoked' && <p role="status">API key revoked.</p>}
      {status === 'unavailable' && <p role="status">This API key is unavailable.</p>}
      <KeyForm workspace={workspace} />
      {keys.length ? <ul className="post-list">{keys.map((key) => (
        <li key={key.id}>
          <article>
            <h2>{key.name}</h2>
            <p><code>{key.prefix}…</code> · {key.scopes.join(', ')}</p>
            <p>{key.revokedAt ? 'Revoked' : key.expiresAt <= new Date() ? 'Expired' : 'Active'} · Expires {date.format(key.expiresAt)}</p>
            {!key.revokedAt && key.expiresAt > new Date() && <form action={revokeKeyAction}>
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="id" value={key.id} />
              <button type="submit">Revoke {key.name}</button>
            </form>}
          </article>
        </li>
      ))}</ul> : <p>No API keys yet.</p>}
    </>
  );
}
