import { listInvitations, listMemberships } from '@cadencedesk/data';
import Link from 'next/link';
import { requireUser } from '../../lib/require-user';
import { acceptInvitationAction, createWorkspaceAction, logoutAction } from './actions';

export const dynamic = 'force-dynamic';

const messages: Record<string, string> = {
  'oauth-invalid': 'The connection request expired or belongs to a different account. Start again from Channels.',
  'invalid-workspace': 'Enter a valid workspace name and IANA time zone.',
  'invalid-invitation': 'Check the invitation details and try again.',
  'invitation-unavailable': 'This invitation is unavailable for your account.',
};

export default async function WorkspaceDirectory({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUser();
  const [memberships, invitations, { status }] = await Promise.all([
    listMemberships(user.id),
    listInvitations(user.email),
    searchParams,
  ]);
  return (
    <main className="identity-shell workspace-directory">
      <Link className="wordmark" href="/">CadenceDesk AI</Link>
      <h1>Your workspaces</h1>
      <p>{user.email}</p>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {memberships.length ? (
        <ul className="workspaces-list">
          {memberships.map(({ workspace, role }) => (
            <li key={workspace.id}>
              <Link href={`/app/${workspace.slug}`}>{workspace.name}</Link>
              <span>{role.toLowerCase()}</span>
            </li>
          ))}
        </ul>
      ) : <p>Create a workspace or accept an invitation to get started.</p>}
      {invitations.length > 0 && (
        <section>
          <h2>Invitations</h2>
          <ul className="workspaces-list">
            {invitations.map((invite) => (
              <li key={invite.id}>
                <span>{invite.workspace.name} · {invite.role.toLowerCase()}</span>
                <form action={acceptInvitationAction}>
                  <input type="hidden" name="invitationId" value={invite.id} />
                  <button type="submit">Accept invitation</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2>Create a workspace</h2>
        <form action={createWorkspaceAction} className="identity-form">
          <label htmlFor="name">Workspace name</label>
          <input id="name" name="name" maxLength={80} required />
          <label htmlFor="timeZone">Time zone</label>
          <input id="timeZone" name="timeZone" defaultValue="UTC" maxLength={100} required aria-describedby="time-zone-help" />
          <p id="time-zone-help">Use an IANA time zone such as Asia/Kolkata.</p>
          <button type="submit" className="primary">Create workspace</button>
        </form>
      </section>
      <form action={logoutAction}><button type="submit">Sign out</button></form>
    </main>
  );
}
