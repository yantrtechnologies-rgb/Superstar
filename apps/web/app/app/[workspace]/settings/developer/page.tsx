import { canManageTeam, getProvider, metaConfiguration } from '@cadencedesk/data';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../../lib/require-user';

const definitions = [
  { id: 'facebook', name: 'Facebook & Instagram', env: ['META_APP_ID', 'META_APP_SECRET'], callback: '/api/connect/meta' },
  { id: 'linkedin', name: 'LinkedIn', env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'], callback: '/api/connect/linkedin' },
  { id: 'youtube', name: 'YouTube', env: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'], callback: '/api/connect/youtube' },
  { id: 'x', name: 'X', env: ['X_CLIENT_ID', 'X_CLIENT_SECRET'], callback: '/api/connect/x' },
] as const;

export default async function DeveloperSettings({ params }: { params: Promise<{ workspace: string }> }) {
  const user = await requireUser();
  const { workspace } = await params;
  const membership = await getMembership(user.id, workspace);
  if (!membership || !canManageTeam(membership.role)) notFound();
  const origin = process.env.APP_URL;
  return (
    <>
      <h1>Provider developer settings</h1>
      <p>Credentials stay in server environment variables. Copy the exact callback into each provider console.</p>
      <div className="developer-grid">
        {definitions.map((item) => {
          const adapter = getProvider(item.id);
          const configured = item.id === 'facebook' ? Boolean(metaConfiguration())
            : Boolean(adapter?.kind === 'oauth' && adapter.configured());
          const callback = origin ? new URL(item.callback, origin).href : `APP_URL${item.callback}`;
          return (
            <section key={item.id}>
              <h2>{item.name}</h2>
              <p role="status">{configured ? 'Configured for per-user OAuth' : 'Configuration required'}</p>
              <dl>
                <dt>Callback URL</dt><dd><code>{callback}</code></dd>
                <dt>Required environment variables</dt><dd><code>{item.env.join(', ')}</code></dd>
              </dl>
            </section>
          );
        })}
      </div>
      <section>
        <h2>Provider requirements</h2>
        <ul>
          <li>YouTube: enable YouTube Data API v3 and request upload plus channel-read scopes. Public apps may require Google verification.</li>
          <li>LinkedIn profiles: enable OpenID Connect and Share on LinkedIn with <code>w_member_social</code>.</li>
          <li>LinkedIn Pages: request Community Management API access, enable <code>r_organization_admin</code> and <code>w_organization_social</code>, then set <code>LINKEDIN_ORGANIZATION_ENABLED=true</code>. Each user sees only Pages their LinkedIn account administers.</li>
          <li>X: enable OAuth 2.0 Authorization Code with PKCE, offline access, and read/write app permissions.</li>
        </ul>
      </section>
      <section>
        <h2>Scheduling and content calendar</h2>
        <p>Connected destinations use the same durable scheduler. Approve a post, choose an exact UTC time, publish immediately, or use the next workspace posting slot. Scheduled content appears in the workspace Agenda in the configured workspace time zone.</p>
      </section>
    </>
  );
}
