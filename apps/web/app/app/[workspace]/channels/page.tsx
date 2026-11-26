import { metaConnectionAction } from './meta/actions';
import { metaConfiguration, canManageTeam, connectLinkProviderName, connectLinkProviders, getProvider, linkedInPagesConfigured, listChannels, listConnectLinks, providerIds, providers, reminderNetwork, reminderNetworks, reminderRecipients } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { connectChannelAction, disconnectOAuthAction, startOAuthAction } from '../publishing-actions';
import { connectLinkAction } from './connect-link-actions';
import { CopyLink } from './copy-link';
import { reminderChannelAction } from './reminder-actions';

const messages: Record<string, string> = {
  saved: 'Channel connected.',
  'plan-limit': 'The channel limit on your plan is reached, so nothing new was connected. Upgrade on the Billing page, or disconnect a channel first.',
  'linkedin-pages-not-approved': 'LinkedIn hasn\'t approved company-page access for Superstar yet (LinkedIn is reviewing it). You can connect your personal LinkedIn profile meanwhile; page connection will work as soon as LinkedIn approves.',
  'linkedin-no-pages': 'LinkedIn found no company pages where you are an administrator. Ask a page admin to add you as an admin, then connect again.',
  'oauth-canceled': 'Connection canceled, so nothing was connected. You can try again whenever you are ready.',
  'meta-canceled': 'Authorization canceled. You can try again when ready.',
  'meta-permissions': 'Grant the requested Page and Instagram permissions, then reconnect.',
  'meta-empty': 'No eligible accounts were found. Use a Facebook Page you manage (personal profiles can\'t be connected), and in the Facebook window choose "Edit access" and tick your Pages. Instagram requires a professional account linked to that Page.',
  'meta-unavailable': 'The connection could not be completed. Start again and check the app configuration and granted permissions.',
  'meta-disconnected': 'Account disconnected from this workspace.',
  disconnected: 'LinkedIn disconnected. Its publishing history is still available.',
  invalid: 'Enter a destination ID in the format shown for that provider.',
  unavailable: 'You do not have access to manage this connection.',
  provider: 'Check the workspace destination grant, bot configuration and provider access.',
  'linkedin-unavailable': 'LinkedIn authorization was unsuccessful. Check the app configuration and try again.',
  'youtube-unavailable': 'YouTube authorization was unsuccessful. Check Google OAuth configuration and try again.',
  'youtube-no-channel': 'That Google account has no YouTube channel. Create a channel at youtube.com, then connect again.',
  'x-unavailable': 'X authorization was unsuccessful. Check the X app configuration and try again.',
  'link-created': 'Connect link created. Copy it below and send it to your client.',
  'link-revoked': 'Connect link revoked. It no longer works.',
  'link-unavailable': 'That connect link could not be created or changed. Check the network is configured, then try again.',
  'instagram-unavailable': 'Instagram sign-in was unsuccessful, so nothing was connected. Grant both requested permissions and try again.',
  'instagram-not-professional': 'That Instagram account is a personal account. Switch it to Business or Creator in the Instagram app (Settings → Account type and tools), then connect again.',
  'reminder-added': 'Reminder channel added. Choose it when you schedule a post, and Superstar emails the post kit when it is due.',
  'reminder-removed': 'Reminder channel removed. Posts already sent stay on the Reminders page.',
  'reminder-invalid': 'Give the reminder channel a name and choose who gets the email.',
};

// How each network decides which account gets connected, so testers never connect someone else's account by accident.
const accountNotes: Record<string, { text: string; signOut?: string }> = {
  facebook: { text: 'Facebook asks for the password of the account signed in on this browser. If it shows someone else, choose "Not you?" or "Log in with another account". When Facebook lists your Pages, tick every Page you want (choose "Edit access" if it skips that step); you can connect several Pages at once. Personal profiles can\'t be connected: Facebook only lets apps post to Pages. For a profile or Group, add a reminder channel below instead. If Facebook says "Feature Unavailable", the Superstar owner needs to add you as a tester; come back here with your browser\'s Back button.' },
  instagram: { text: 'Facebook asks for the password of the account signed in on this browser. If it shows someone else, choose "Not you?" or "Log in with another account". If Facebook says "Feature Unavailable", the Superstar owner needs to add you as a tester; come back here with your browser\'s Back button.' },
  'instagram-direct': { text: 'Instagram always asks you to log in, so you can pick the right account. It must be a Business or Creator account (free to switch in the Instagram app); no Facebook Page is needed.' },
  youtube: { text: 'Google shows its account chooser. Pick your own account, or "Use another account".' },
  linkedin: { text: 'LinkedIn always connects the account already signed in on this browser and cannot be asked to switch. If that is not you, sign out of LinkedIn first.', signOut: 'https://www.linkedin.com/m/logout/' },
  x: { text: 'On X\'s page, tick "I trust this app" first: the Authorize app button stays greyed out until you do. X connects the account already signed in on this browser. If that is not you, sign out of X first.', signOut: 'https://x.com/logout' },
};

function AccountNote({ provider }: { provider: string }) {
  const note = accountNotes[provider];
  if (!note) return null;
  return (
    <p className="account-note">
      {note.text}
      {note.signOut && <> <a href={note.signOut} target="_blank" rel="noreferrer">Sign out of {provider === 'x' ? 'X' : 'LinkedIn'}</a>, then come back and connect.</>}
    </p>
  );
}

export default async function Channels({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  const channels = await listChannels(user.id, workspace);
  const canManage = canManageTeam(membership.role);
  const linkProviders = canManage ? connectLinkProviders() : [];
  const links = canManage ? await listConnectLinks(user.id, workspace) : [];
  const recipients = canManage ? await reminderRecipients(user.id, workspace) : [];
  const marks: Record<string, string> = { facebook: 'f', instagram: 'ig', linkedin: 'in', youtube: '▶', x: 'X', telegram: 'tg', discord: 'dc', reminder: '⏰', 'instagram-direct': 'ig' };
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Channels</h1>
          <p>Connected accounts you can publish to from this workspace.</p>
        </div>
        <Link className="btn" href={`/app/${workspace}/channels/organization`}>Channel groups and posting slots</Link>
      </header>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {channels.length ? (
        <ul className="channel-grid">
          {channels.map((channel) => {
            const provider = getProvider(channel.provider);
            const credential = channel.credential;
            const meta = channel.provider === 'facebook' || channel.provider === 'instagram';
            const oauth = provider?.kind === 'oauth' || meta;
            const health = !credential || credential.revokedAt ? ['Reconnect required', 'badge-bad']
              : credential.accessExpiresAt.getTime() <= Date.now() ? ['Access token expired', 'badge-warn'] : ['Authorized', 'badge-ok'];
            return (
              <li key={channel.id} className="channel-card">
                <header>
                  <span className="channel-avatar" data-provider={channel.provider} aria-hidden="true">
                    {channel.name.slice(0, 1)}<small>{marks[channel.provider] ?? ''}</small>
                  </span>
                  <div>
                    <strong>{channel.name}</strong>
                    <span>{channel.provider === 'reminder' ? `${reminderNetwork(channel.externalId).name} · reminder`
                      : provider?.name ?? (channel.provider === 'facebook' ? 'Facebook Page' : channel.provider === 'instagram' ? 'Instagram' : channel.provider)}</span>
                  </div>
                </header>
                {channel.provider === 'reminder' ? (
                  <>
                    {channel.reminderEmail
                      ? <span className="badge badge-ok">Emails {channel.reminderEmail}</span>
                      : <span className="badge badge-muted">Reminders off</span>}
                    {canManage && channel.reminderEmail && (
                      <form action={reminderChannelAction}>
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="workspace" value={workspace} />
                        <input type="hidden" name="channelId" value={channel.id} />
                        <button type="submit" className="btn">Remove {channel.name}</button>
                      </form>
                    )}
                  </>
                ) : oauth ? <span className={'badge ' + health[1]}>{health[0]}</span> : <span className="badge badge-ok">Bot connected</span>}
                {meta && <p>Ready for draft selection and scheduled publishing.</p>}
                {meta && canManage && credential && (
                  <form action={metaConnectionAction}>
                    <input type="hidden" name="intent" value="disconnect" />
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="channelId" value={channel.id} />
                    <button type="submit" className="btn">Disconnect {channel.name}</button>
                  </form>
                )}
                {(['linkedin', 'youtube', 'x', 'instagram-direct'].includes(channel.provider)) && canManage && credential && (
                  <form action={disconnectOAuthAction}>
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="channelId" value={channel.id} />
                    <input type="hidden" name="provider" value={channel.provider} />
                    <button type="submit" className="btn">Disconnect {channel.name}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      ) : <section className="panel"><p>No channels are connected yet. Pick a network below to add your first one.</p></section>}
      {canManage && <>
        <h2>Add a channel</h2>
        <p className="connect-hint">
          Each network opens its own sign-in, so you connect <strong>your</strong> account. Superstar never uses anyone
          else&apos;s connection. If a network shows someone else&apos;s name, follow the note on its card, or use a private window.
        </p>
        <div className="provider-grid">
          {(['facebook', 'instagram'] as const).map((provider) => (
            <section key={provider} className="provider-card">
              <h3><span className="channel-avatar" data-provider={provider} aria-hidden="true">{marks[provider]}</span>Connect {provider === 'facebook' ? 'Facebook Pages' : 'Instagram'}</h3>
              <p>{provider === 'facebook'
                ? 'Sign in with Facebook and choose the Pages you manage.'
                : 'Sign in with Facebook to select professional Instagram accounts linked to your Pages.'}</p>
              <AccountNote provider={provider} />
              {metaConfiguration() ? (
                <form action={metaConnectionAction}>
                  <input type="hidden" name="intent" value="connect" />
                  <input type="hidden" name="workspace" value={workspace} />
                  <input type="hidden" name="provider" value={provider} />
                  <button type="submit" className="primary">Continue with Facebook for {provider === 'facebook' ? 'Pages' : 'Instagram'}</button>
                </form>
              ) : (
                <details>
                  <summary>Connection setup required</summary>
                  <p className="muted-line">Ask your operator to configure the Meta app ID, app secret, API version and token encryption key, and register the /api/connect/meta callback for this site&apos;s address.</p>
                  <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Open Meta app dashboard</a>
                </details>
              )}
            </section>
          ))}
          {providerIds.filter((id) => !['facebook', 'instagram', 'reminder'].includes(id)).map((id) => {
            const provider = providers[id];
            if (provider.kind === 'reminder') return null;
            const configured = provider.kind === 'oauth' ? provider.configured()
              : Boolean(process.env[provider.tokenEnv] && process.env[provider.grantsEnv]);
            return (
              <section key={id} className="provider-card">
                <h3><span className="channel-avatar" data-provider={id} aria-hidden="true">{marks[id] ?? provider.name.slice(0, 1)}</span>Connect {provider.name}</h3>
                <p>{provider.connectionHelp}</p>
                {provider.kind === 'oauth' && <AccountNote provider={id} />}
                {!configured ? <span className="badge badge-muted">Operator configuration required</span> : provider.kind === 'bot' ? (
                  <form action={connectChannelAction} className="identity-form">
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="provider" value={id} />
                    <label htmlFor={`channel-${id}`}>{provider.destinationLabel}</label>
                    <input id={`channel-${id}`} name="channel" maxLength={40} required />
                    <button type="submit" className="primary">Connect or refresh {provider.name}</button>
                  </form>
                ) : (
                  <form action={startOAuthAction}>
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="provider" value={id} />
                    <button type="submit" className="primary">Authorize or reconnect {provider.name}</button>
                  </form>
                )}
              </section>
            );
          })}
          {linkedInPagesConfigured() && (
            <section className="provider-card">
              <h3><span className="channel-avatar" data-provider="linkedin" aria-hidden="true">{marks.linkedin ?? 'in'}</span>Connect LinkedIn Page</h3>
              <p>Post as your company page instead of your personal profile. Sign in with a LinkedIn account that is an admin of the page; every page you administer is added as a channel.</p>
              <p className="account-note">LinkedIn must approve Superstar for company pages. If it hasn&apos;t yet, you&apos;ll see a message here after signing in, and nothing is connected.</p>
              <form action={startOAuthAction}>
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="provider" value="linkedin-pages" />
                <button type="submit" className="primary">Connect LinkedIn Page</button>
              </form>
            </section>
          )}
          <section id="reminder-channel" className="provider-card">
            <h3><span className="channel-avatar" data-provider="reminder" aria-hidden="true">⏰</span>Facebook profile, Group or other (reminder)</h3>
            <p>
              Facebook doesn&apos;t let any app post to personal profiles or Groups. Add one here, and when a post is due
              Superstar emails the text and media to the person you choose. They post it themselves in a minute, then mark it
              done on the Reminders page.
            </p>
            <form action={reminderChannelAction} className="identity-form">
              <input type="hidden" name="intent" value="add" />
              <input type="hidden" name="workspace" value={workspace} />
              <label htmlFor="reminder-network">Where it gets posted</label>
              <select id="reminder-network" name="network" defaultValue="facebook-profile">
                {Object.entries(reminderNetworks).map(([id, network]) => <option key={id} value={id}>{network.name}</option>)}
              </select>
              <label htmlFor="reminder-name">Name</label>
              <input id="reminder-name" name="name" maxLength={80} required placeholder="e.g. Reshma Patel's profile" />
              <label htmlFor="reminder-recipient">Email the reminder to</label>
              <select id="reminder-recipient" name="recipientId" required>
                {recipients.map((member) => <option key={member.id} value={member.id}>{member.name ? `${member.name} (${member.email})` : member.email}</option>)}
              </select>
              <p className="muted-line">Only workspace members can get reminders. To remind a client, invite them on Team settings first.</p>
              <button type="submit" className="primary">Add reminder channel</button>
            </form>
          </section>
        </div>
        {linkProviders.length > 0 && (
          <section id="client-links" className="panel">
            <h2>Client connect links</h2>
            <p>
              Let a client connect their own account without sharing a password or creating a Superstar account. Create a link,
              send it to them, and they sign in on the network themselves; the account then appears in this workspace.
              Links work for 7 days and can be used several times until you revoke them.
            </p>
            <form action={connectLinkAction} className="identity-form">
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="workspace" value={workspace} />
              <label htmlFor="link-provider">Network</label>
              <select id="link-provider" name="provider" required defaultValue={linkProviders[0]}>
                {linkProviders.map((id) => <option key={id} value={id}>{connectLinkProviderName(id)}</option>)}
              </select>
              <label htmlFor="link-label">Client name (optional, shown to the client)</label>
              <input id="link-label" name="label" maxLength={80} placeholder="e.g. Sharma Dental Clinic" />
              <button type="submit" className="primary">Create connect link</button>
            </form>
            {links.length > 0 && (
              <ul className="connect-links">
                {links.map((link) => (
                  <li key={link.id}>
                    <p>
                      <strong>{link.providerName}</strong>{link.label ? ` · ${link.label}` : ''}
                      <small> — by {link.createdBy}, expires {link.expiresAt.toUTCString().slice(0, 16)}
                        {link.lastUsedAt ? `, last opened ${link.lastUsedAt.toUTCString().slice(0, 22)} UTC` : ', not opened yet'}</small>
                    </p>
                    <CopyLink url={link.url} label={`Connect link for ${link.providerName}${link.label ? ' · ' + link.label : ''}`} />
                    <form action={connectLinkAction}>
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="workspace" value={workspace} />
                      <input type="hidden" name="link" value={link.id} />
                      <button type="submit" className="btn">Revoke</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </>}
    </>
  );
}
