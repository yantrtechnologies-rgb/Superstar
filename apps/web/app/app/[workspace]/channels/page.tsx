import { metaConnectionAction } from './meta/actions';
import { metaConfiguration, canManageTeam, findMembership, getProvider, listChannels, providerIds, providers } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { connectChannelAction, disconnectOAuthAction, startOAuthAction } from '../publishing-actions';

const messages: Record<string, string> = {
  saved: 'Channel connected.',
  'meta-canceled': 'Authorization canceled. You can try again when ready.',
  'meta-permissions': 'Grant the requested Page and Instagram permissions, then reconnect.',
  'meta-empty': 'No eligible accounts were found. Use a Facebook Page you manage. Instagram requires a professional account linked to that Page.',
  'meta-unavailable': 'The connection could not be completed. Start again and check the app configuration and granted permissions.',
  'meta-disconnected': 'Account disconnected from this workspace.',
  disconnected: 'LinkedIn disconnected. Its publishing history is still available.',
  invalid: 'Enter a destination ID in the format shown for that provider.',
  unavailable: 'You do not have access to manage this connection.',
  provider: 'Check the workspace destination grant, bot configuration and provider access.',
  'linkedin-unavailable': 'LinkedIn authorization was unsuccessful. Check the app configuration and try again.',
  'youtube-unavailable': 'YouTube authorization was unsuccessful. Check Google OAuth configuration and try again.',
  'x-unavailable': 'X authorization was unsuccessful. Check the X app configuration and try again.',
};

export default async function Channels({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const membership = await findMembership(user.id, workspace);
  if (!membership) notFound();
  const channels = await listChannels(user.id, workspace);
  const canManage = canManageTeam(membership.role);
  return (
    <>
      <h1>Channels</h1>
      <Link href={`/app/${workspace}/channels/organization`}>Channel groups and posting slots</Link>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {channels.length ? (
        <ul className="workspaces-list">
          {channels.map((channel) => {
            const provider = getProvider(channel.provider);
            const credential = channel.credential;
            const meta = channel.provider === 'facebook' || channel.provider === 'instagram';
            return (
              <li key={channel.id}>
                <span>{channel.name}</span>
                <span>{provider?.name ?? (channel.provider === 'facebook' ? 'Facebook Page' : channel.provider === 'instagram' ? 'Instagram' : channel.provider)}</span>
                {(provider?.kind === 'oauth' || meta) && <span>{
                  !credential || credential.revokedAt ? 'Reconnect required'
                    : credential.accessExpiresAt.getTime() <= Date.now() ? 'Access token expired' : 'Authorized'
                }</span>}
                {meta && <span>Ready for draft selection and scheduled publishing.</span>}
                {meta && canManage && credential && (
                  <form action={metaConnectionAction}>
                    <input type="hidden" name="intent" value="disconnect" />
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="channelId" value={channel.id} />
                    <button type="submit">Disconnect {channel.name}</button>
                  </form>
                )}
                {(['linkedin', 'youtube', 'x'].includes(channel.provider)) && canManage && credential && (
                  <form action={disconnectOAuthAction}>
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="channelId" value={channel.id} />
                    <input type="hidden" name="provider" value={channel.provider} />
                    <button type="submit">Disconnect {channel.name}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      ) : <p>No channels are connected yet.</p>}
      {canManage && (['facebook', 'instagram'] as const).map((provider) => (
        <section key={provider} className="my-5 rounded-xl border border-stone-300 bg-white p-5">
          <h2>Connect {provider === 'facebook' ? 'Facebook Pages' : 'Instagram'}</h2>
          <p>{provider === 'facebook'
            ? 'Sign in with Facebook and choose the Pages you manage.'
            : 'Sign in with Facebook to select professional Instagram accounts linked to your Pages.'}</p>
          {metaConfiguration() ? (
            <form action={metaConnectionAction} className="mt-3">
              <input type="hidden" name="intent" value="connect" />
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="provider" value={provider} />
              <button type="submit">Continue with Facebook for {provider === 'facebook' ? 'Pages' : 'Instagram'}</button>
            </form>
          ) : (
            <details className="mt-3">
              <summary className="cursor-pointer">Connection setup required</summary>
              <p>Ask your operator to configure the Meta app ID, app secret, API version and token encryption key, and register the /api/connect/meta callback for this site's address.</p>
              <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Open Meta app dashboard</a>
            </details>
          )}
          <p className="mt-3 text-sm">Connect accounts to select them as destinations and publish through Meta.</p>
        </section>
      ))}
      {canManage && providerIds.filter((id) => !['facebook', 'instagram'].includes(id)).map((id) => {
        const provider = providers[id];
        const configured = provider.kind === 'oauth' ? provider.configured()
          : Boolean(process.env[provider.tokenEnv] && process.env[provider.grantsEnv]);
        return (
          <section key={id}>
            <h2>Connect {provider.name}</h2>
            <p>{provider.connectionHelp}</p>
            {!configured ? <p>Operator configuration is required.</p> : provider.kind === 'bot' ? (
              <form action={connectChannelAction} className="identity-form">
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="provider" value={id} />
                <label htmlFor={`channel-${id}`}>{provider.destinationLabel}</label>
                <input id={`channel-${id}`} name="channel" maxLength={40} required />
                <button type="submit">Connect or refresh {provider.name}</button>
              </form>
            ) : (
              <form action={startOAuthAction}>
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="provider" value={id} />
                <button type="submit">Authorize or reconnect {provider.name}</button>
              </form>
            )}
          </section>
        );
      })}
    </>
  );
}
