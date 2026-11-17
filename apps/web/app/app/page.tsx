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

export default async function WorkspaceDirectory({ searchParams }: { searchParams: Promise<{ status?: string; intent?: string }> }) {
  const { status, intent } = await searchParams;
  const connecting = intent === 'channels';
  const user = await requireUser(connecting ? '/login?intent=channels' : '/login');
  const [memberships, invitations] = await Promise.all([
    listMemberships(user.id),
    listInvitations(user.email),
  ]);
  return (
    <main className="identity-shell workspace-directory">
      <Link className="wordmark" href="/">Superstar</Link>
      <h1>Your workspaces</h1>
      <p>{user.email}</p>
      {connecting && <p>Choose a workspace to connect your channels.</p>}
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {memberships.length ? (
        <ul className="workspaces-list">
          {memberships.map(({ workspace, role }) => (
            <li key={workspace.id}>
              <Link href={`/app/${workspace.slug}${connecting ? '/channels' : ''}`}>{workspace.name}</Link>
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
          {connecting && <input type="hidden" name="intent" value="channels" />}
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
