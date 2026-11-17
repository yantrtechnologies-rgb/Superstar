'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const pages = [
  ['', 'Overview'], ['/calendar', 'Agenda'], ['/posts', 'Posts'], ['/channels', 'Channels'],
  ['/analytics', 'Analytics'], ['/studio', 'AI Studio'], ['/automations', 'Automations'],
  ['/settings', 'Team settings'],
] as const;

export function WorkspaceNav({ workspace, canManage }: { workspace: string; canManage: boolean }) {
  const pathname = usePathname();
  const base = '/app/' + workspace;
  const entries = canManage ? [...pages, ['/billing', 'Usage and billing'] as const] : pages;
  return (
    <nav aria-label="Workspace navigation">
      {entries.map(([suffix, label]) => {
        const href = base + suffix;
        const active = pathname === href || (suffix !== '' && pathname.startsWith(href + '/'));
        return <Link key={href} href={href} aria-current={active ? 'page' : undefined}>{label}</Link>;
      })}
    </nav>
  );
}
