'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

const icons = {
  home: icon(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></>),
  calendar: icon(<><rect x="3" y="4.5" width="18" height="16.5" rx="2.5" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /><path d="M7.5 13.5h3v3h-3z" /></>),
  posts: icon(<><path d="M5 3.5h10l4 4V20.5H5z" /><path d="M14.5 3.5V8h4.5M8.5 12.5h7M8.5 16h5" /></>),
  channels: icon(<><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="5.5" r="2.5" /><circle cx="18" cy="18.5" r="2.5" /><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1" /></>),
  analytics: icon(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>),
  studio: icon(<><path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>),
  automations: icon(<><path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z" /></>),
  settings: icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>),
  media: icon(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5.5-5.5L5 20" /></>),
  content: icon(<><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" /></>),
  inbox: icon(<><path d="M4 5.5h16v10H14l-2 3-2-3H4z" /><path d="M8 9.5h8M8 12.5h5" /></>),
  reminders: icon(<><circle cx="12" cy="13" r="7.5" /><path d="M12 9.5V13l2.5 2M4.5 4.5l3 -2M19.5 4.5l-3-2" /></>),
  billing: icon(<><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 10h19M6.5 15h4" /></>),
};

const groups = [
  ['Publish', [['', 'Overview', 'home'], ['/calendar', 'Calendar', 'calendar'], ['/posts', 'Posts', 'posts'], ['/media', 'Media', 'media'], ['/channels', 'Channels', 'channels'], ['/reminders', 'Reminders', 'reminders']]],
  ['Grow', [['/inbox', 'Inbox', 'inbox'], ['/analytics', 'Analytics', 'analytics'], ['/studio', 'AI Studio', 'studio'], ['/automations', 'Automations', 'automations']]],
  ['Workspace', [['/settings/content', 'Tags & signatures', 'content'], ['/settings', 'Team settings', 'settings']]],
] as const;

/** Each section has its own colour; each item its own gradient icon tile (see .nav-icon in globals.css). */
const groupTone = { Publish: 'sunrise', Grow: 'aurora', Workspace: 'ocean' } as const;

export function WorkspaceNav({ workspace, canManage }: { workspace: string; canManage: boolean }) {
  const pathname = usePathname();
  const base = '/app/' + workspace;
  return (
    <nav aria-label="Workspace navigation" className="app-nav">
      {groups.map(([title, items]) => (
        <div key={title} className="app-nav" role="group" aria-label={title}>
          <p className="app-nav-label" data-tone={groupTone[title]}>{title}</p>
          {[...items, ...(title === 'Workspace' && canManage ? [['/billing', 'Usage and billing', 'billing'] as const] : [])].map(([suffix, label, name]) => {
            const href = base + suffix;
            const active = pathname === href || (suffix !== '' && pathname.startsWith(href + '/')
              && !(suffix === '/settings' && pathname.startsWith(base + '/settings/content')));
            return (
              <Link key={href} href={href} aria-current={active ? 'page' : undefined} data-item={name}>
                <span className="nav-icon" data-item={name}>{icons[name]}</span>
                <span className="nav-text">{label}</span>
                {name === 'studio' && <span className="nav-badge">AI</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
