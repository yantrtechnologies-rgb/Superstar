import { canManageTeam, findMembership, getProvider, listChannels, providerIds, providers } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { connectChannelAction, disconnectLinkedInAction, startLinkedInAction } from '../publishing-actions';

const messages: Record<string, string> = {
  saved: 'Channel connected.',
  disconnected: 'LinkedIn disconnected. Its publishing history is still available.',
  invalid: 'Enter a destination ID in the format shown for that provider.',
  unavailable: 'You do not have access to manage this connection.',
  provider: 'Check the workspace destination grant, bot configuration and provider access.',
  'linkedin-unavailable': 'LinkedIn authorization was unsuccessful. Check the app configuration and try again.',
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
            return (
              <li key={channel.id}>
                <span>{channel.name}</span>
                <span>{provider?.name ?? channel.provider}</span>
                {provider?.kind === 'oauth' && <span>{
                  !credential || credential.revokedAt ? 'Reconnect required'
                    : credential.accessExpiresAt.getTime() <= Date.now() ? 'Access token expired' : 'Authorized'
                }</span>}
                {channel.provider === 'linkedin' && canManage && credential && (
                  <form action={disconnectLinkedInAction}>
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="channelId" value={channel.id} />
                    <button type="submit">Disconnect {channel.name}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      ) : <p>No channels are connected yet.</p>}
      {canManage && providerIds.map((id) => {
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
              <form action={startLinkedInAction}>
                <input type="hidden" name="workspace" value={workspace} />
                <button type="submit">Authorize or reconnect LinkedIn</button>
              </form>
            )}
          </section>
        );
      })}
    </>
  );
}
