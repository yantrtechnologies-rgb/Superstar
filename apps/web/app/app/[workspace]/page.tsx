import { findMembership } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../lib/require-user';

export default async function WorkspaceHome({ params }: { params: Promise<{ workspace: string }> }) {
  const user = await requireUser();
  const { workspace } = await params;
  const membership = await findMembership(user.id, workspace);
  if (!membership) notFound();
  return (
    <>
      <h1>{membership.workspace.name}</h1>
      <dl className="workspace-details">
        <div><dt>Your role</dt><dd>{membership.role.toLowerCase()}</dd></div>
        <div><dt>Workspace time zone</dt><dd>{membership.workspace.timeZone}</dd></div>
      </dl>
      <Link href={`/app/${workspace}/settings`}>View team settings</Link>
    </>
  );
}
