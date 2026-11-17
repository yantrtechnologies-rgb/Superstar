import { findMembership, listMemberships } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireUser } from '../../../lib/require-user';
import { logoutAction } from '../actions';
import { WorkspaceNav } from './workspace-nav';

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
      <a href="#workspace-content" className="skip-link">Skip to content</a>
      <aside>
        <Link className="wordmark" href="/app">Superstar</Link>
        <WorkspaceNav workspace={workspace} canManage={membership.role === 'OWNER' || membership.role === 'ADMIN'} />
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
      <main id="workspace-content"><div className="workspace-content">{children}</div></main>
    </div>
  );
}
