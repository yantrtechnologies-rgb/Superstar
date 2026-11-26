import { connectLinkPreview } from '@cadencedesk/data';
import { startConnectLinkAction } from '../actions';

export const metadata = { title: 'Connect your account · Superstar', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function ConnectLinkPage({ params, searchParams }: {
  params: Promise<{ token: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const [{ token }, { status }] = await Promise.all([params, searchParams]);
  const link = await connectLinkPreview(token);
  if (!link) {
    return (
      <main className="identity-shell">
        <p className="wordmark">Superstar</p>
        <h1>This link is no longer valid</h1>
        <p>Connect links expire after 7 days and can be revoked. Ask whoever sent it to you for a new one.</p>
      </main>
    );
  }
  const network = link.providerName;
  // The site the client actually signs in on, which differs from the product name for Pages, Instagram and YouTube.
  const site = ({ facebook: 'Facebook', instagram: 'Facebook', linkedin: 'LinkedIn', 'linkedin-pages': 'LinkedIn', youtube: 'Google', x: 'X' } as Record<string, string>)[link.provider] ?? network;
  const accounts = link.provider === 'facebook' ? 'Facebook Pages' : `${network} account`;
  return (
    <main className="identity-shell">
      <p className="wordmark">Superstar</p>
      <h1>Connect your {network} to {link.workspaceName}</h1>
      {link.label && <p>Prepared for <strong>{link.label}</strong>.</p>}
      <section className="panel">
        <ul className="connect-link-points">
          <li><strong>Only continue if you know and trust {link.workspaceName}.</strong> They sent you this link.</li>
          <li>{link.workspaceName} will be able to schedule and publish posts to the {accounts} you connect, from their Superstar workspace.</li>
          <li>You don&apos;t need a Superstar account, and Superstar never sees your {site} password: you sign in on {site}&apos;s own page.</li>
          <li>You can remove the access at any time in your {site} settings, or ask {link.workspaceName} to disconnect it.</li>
        </ul>
      </section>
      {status === 'busy' && <p role="status">Too many attempts with this link. Wait 10 minutes and try again.</p>}
      <form action={startConnectLinkAction} className="identity-form">
        <input type="hidden" name="token" value={token} />
        <button type="submit" className="primary">Continue to {site}</button>
      </form>
      <p className="muted-line">
        {link.provider === 'facebook' || link.provider === 'instagram'
          ? 'On Facebook, choose "Edit access" and tick every Page you want to connect. '
          : ''}
        Not what you expected? Close this page and nothing is connected. This link works until {link.expiresAt.toUTCString().slice(0, 16)}.
      </p>
    </main>
  );
}
