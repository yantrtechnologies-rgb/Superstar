import { canManageTeam, invitationRoles, listWorkspaceTeam, ownerInvitationRoles } from '@cadencedesk/data';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { inviteMemberAction } from '../../actions';

const messages: Record<string, string> = {
  invited: 'Invitation sent.',
  'email-unavailable': 'Email delivery requires operator configuration.',
  'email-failed': 'The invitation is active, but email delivery failed. Submit it again to retry.',
  'invitation-unavailable': 'Check your permissions and whether this person is already a member.',
};

export default async function TeamSettings({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace: slug }, { status }] = await Promise.all([params, searchParams]);
  const team = await listWorkspaceTeam(user.id, slug);
  if (!team) notFound();
  return (
    <>
      <h1>Team settings</h1>
      <h2>{team.workspace.name}</h2>
      <ul className="workspaces-list">
        {team.workspace.memberships.map(({ user: member, role }) => (
          <li key={member.email}><span>{member.name || member.email}</span><span>{role.toLowerCase()}</span></li>
        ))}
      </ul>
      {canManageTeam(team.role) && (
        <section>
          <h2>Invite a teammate</h2>
          {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
          <form action={inviteMemberAction} className="identity-form">
            <input type="hidden" name="slug" value={slug} />
            <label htmlFor="email">Email address</label>
            <input id="email" name="email" type="email" maxLength={254} required />
            <label htmlFor="role">Workspace role</label>
            <select id="role" name="role" defaultValue="EDITOR">
              {(team.role === 'OWNER' ? ownerInvitationRoles : invitationRoles).map((role) => (
                <option key={role} value={role}>{role.toLowerCase()}</option>
              ))}
            </select>
            <button className="primary" type="submit">Send invitation</button>
          </form>
        </section>
      )}
    </>
  );
}
