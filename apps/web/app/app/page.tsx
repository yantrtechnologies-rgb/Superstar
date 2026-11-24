import { listInvitations, listMemberships, planCatalog, prisma } from '@cadencedesk/data';
import Link from 'next/link';
import { readChosenPlan } from '../../lib/chosen-plan';
import { requireUser } from '../../lib/require-user';
import { acceptInvitationAction, createWorkspaceAction, logoutAction, setPasswordAction } from './actions';
import { SubmitButton } from '../login/submit-button';

export const dynamic = 'force-dynamic';

const messages: Record<string, string> = {
  'oauth-invalid': 'The connection request expired or belongs to a different account. Start again from Channels.',
  'invalid-workspace': 'Enter a valid workspace name and IANA time zone.',
  'invalid-invitation': 'Check the invitation details and try again.',
  'invitation-unavailable': 'This invitation is unavailable for your account.',
  'seat-limit': 'That workspace has used all the team member seats on its plan. Ask its owner to upgrade on the Billing page.',
  'password-saved': 'Password saved. You can now sign in with your email and password.',
  'password-weak': 'Use a password of at least 10 characters.',
  'password-mismatch': 'The two new passwords do not match.',
  'password-current': 'Your current password is incorrect.',
};

export default async function WorkspaceDirectory({ searchParams }: { searchParams: Promise<{ status?: string; intent?: string }> }) {
  const { status, intent } = await searchParams;
  const connecting = intent === 'channels';
  const user = await requireUser(connecting ? '/login?intent=channels' : '/login');
  const [memberships, invitations, passwordSet] = await Promise.all([
    listMemberships(user.id),
    listInvitations(user.email),
    prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }).then((row) => Boolean(row?.passwordHash)),
  ]);
  const chosenPlan = connecting ? null : await readChosenPlan();
  const upgradeable = memberships.filter(({ role }) => role === 'OWNER' || role === 'ADMIN');
  return (
    <main className="identity-shell workspace-directory">
      <Link className="wordmark" href="/">Superstar</Link>
      <h1>Your workspaces</h1>
      <p>{user.email}</p>
      {connecting && <p>Choose a workspace to connect your channels.</p>}
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {chosenPlan && (
        <section className="plan-upgrade-banner" role="status">
          <strong>Finish your {planCatalog[chosenPlan].name} plan</strong>
          {upgradeable.length ? (
            <>
              <p>Choose the workspace to upgrade. You will go to the secure Razorpay payment page next.</p>
              <ul>
                {upgradeable.map(({ workspace }) => (
                  <li key={workspace.id}><Link className="primary" href={`/app/${workspace.slug}/billing?plan=${chosenPlan}`}>Upgrade {workspace.name}</Link></li>
                ))}
              </ul>
            </>
          ) : <p>Create your workspace below. You will go to the secure Razorpay payment page right after.</p>}
        </section>
      )}
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
      <section>
        <h2>{passwordSet ? 'Change password' : 'Set a password'}</h2>
        <form action={setPasswordAction} className="identity-form">
          <input type="email" name="username" autoComplete="username" value={user.email} readOnly hidden />
          {passwordSet && <>
            <label htmlFor="current-password">Current password</label>
            <input id="current-password" type="password" name="current" autoComplete="current-password" maxLength={200} required />
          </>}
          <label htmlFor="new-password">New password</label>
          <input id="new-password" type="password" name="password" autoComplete="new-password" minLength={10} maxLength={200} required />
          <label htmlFor="confirm-password">Confirm new password</label>
          <input id="confirm-password" type="password" name="confirm" autoComplete="new-password" minLength={10} maxLength={200} required />
          <SubmitButton pending="Saving…">{passwordSet ? 'Change password' : 'Save password'}</SubmitButton>
        </form>
      </section>
      <form action={logoutAction}><button type="submit">Sign out</button></form>
    </main>
  );
}
