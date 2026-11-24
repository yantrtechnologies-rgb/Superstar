import { canWritePosts, listMemberships } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getMembership, requireUser } from '../../../lib/require-user';
import { logoutAction } from '../actions';
import { PlayfulBackdrop } from './playful-backdrop';
import { WorkspaceNav } from './workspace-nav';

export default async function WorkspaceLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const user = await requireUser();
  const { workspace } = await params;
  const [membership, memberships] = await Promise.all([getMembership(user.id, workspace), listMemberships(user.id)]);
  if (!membership) notFound();
  const label = user.email;
  return (
    <div className="workspace-shell">
      <a href="#workspace-content" className="skip-link">Skip to content</a>
      <aside className="app-sidebar">
        <Link className="wordmark" href="/app">Superstar</Link>
        {canWritePosts(membership.role) && (
          <Link href={`/app/${workspace}/posts/new`} className="sidebar-spark">
            <span aria-hidden="true">✨</span>
            <span><strong>Create a post</strong><small>Write it, or let AI help</small></span>
          </Link>
        )}
        <WorkspaceNav workspace={workspace} canManage={membership.role === 'OWNER' || membership.role === 'ADMIN'} />
        <nav aria-label="Switch workspace" className="app-nav workspace-switch">
          <p className="app-nav-label">Workspaces</p>
          {memberships.map(({ workspace: item }) => (
            <Link key={item.id} href={`/app/${item.slug}`} aria-current={item.slug === workspace ? 'page' : undefined}>
              <span className="ws-initial" aria-hidden="true" data-hue={[...item.name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 6}>{item.name.slice(0, 1)}</span>{item.name}
            </Link>
          ))}
          <Link href="/app">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            Manage workspaces
          </Link>
        </nav>
      </aside>
      <div className="app-main">
        <PlayfulBackdrop />
        <header className="app-topbar">
          <div className="app-topbar-title">
            <strong>{membership.workspace.name}</strong>
            <span className="role-chip">{membership.role.toLowerCase()}</span>
          </div>
          <div className="app-topbar-actions">
            {canWritePosts(membership.role) && (
              <Link href={`/app/${workspace}/posts/new`} className="btn btn-primary" aria-label="Create post">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                <span className="btn-label">Create post</span>
              </Link>
            )}
            <details className="user-menu">
              <summary aria-label="Account menu"><span className="avatar" aria-hidden="true">{label.slice(0, 1)}</span></summary>
              <div className="user-menu-panel">
                <p>Signed in as<br /><strong>{user.email}</strong></p>
                <Link href="/app">All workspaces</Link>
                <Link href={`/app/${workspace}/settings`}>Team settings</Link>
                <form action={logoutAction}><button type="submit" className="btn">Sign out</button></form>
              </div>
            </details>
          </div>
        </header>
        <main id="workspace-content"><div className="workspace-content">{children}</div></main>
      </div>
    </div>
  );
}
