import { findMembership, listMemberships } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireUser } from '../../../lib/require-user';
import { logoutAction } from '../actions';

export default async function WorkspaceLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const user = await requireUser();
  const { workspace } = await params;
  const membership = await findMembership(user.id, workspace);
  if (!membership) notFound();
  const memberships = await listMemberships(user.id);
  return (
    <div className="workspace-shell">
      <aside>
        <Link className="wordmark" href="/app">CadenceDesk AI</Link>
        <nav aria-label="Workspace navigation">
          <Link href={`/app/${workspace}`}>Overview</Link>
          <Link href={`/app/${workspace}/calendar`}>Agenda</Link>
          <Link href={`/app/${workspace}/posts`}>Posts</Link>
          <Link href={`/app/${workspace}/channels`}>Channels</Link>
          <Link href={`/app/${workspace}/settings`}>Team settings</Link>
        </nav>
        <nav aria-label="Switch workspace">
          <h2>Workspaces</h2>
          {memberships.map(({ workspace: item }) => (
            <Link key={item.id} href={`/app/${item.slug}`} aria-current={item.slug === workspace ? 'page' : undefined}>
              {item.name}
            </Link>
          ))}
          <Link href="/app">Manage workspaces</Link>
        </nav>
        <form action={logoutAction}><button type="submit">Sign out</button></form>
      </aside>
      <main>{children}</main>
    </div>
  );
}
