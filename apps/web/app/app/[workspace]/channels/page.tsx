import { canManageTeam, findMembership, getProvider, listChannels, providerIds, providers } from '@cadencedesk/data';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { connectChannelAction } from '../publishing-actions';

const messages: Record<string, string> = {
  saved: 'Channel connected.',
  invalid: 'Enter a destination ID in the format shown for that provider.',
  unavailable: 'You do not have access to connect this channel.',
  provider: 'Check the workspace destination grant, bot configuration and provider access.',
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
  return (
    <>
      <h1>Channels</h1>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {channels.length ? (
        <ul className="workspaces-list">
          {channels.map((channel) => (
            <li key={channel.id}><span>#{channel.name}</span><span>{getProvider(channel.provider)?.name ?? channel.provider}</span></li>
          ))}
        </ul>
      ) : <p>No channels are connected yet.</p>}
      {canManageTeam(membership.role) && providerIds.map((id) => {
        const provider = providers[id];
        const configured = Boolean(process.env[provider.tokenEnv] && process.env[provider.grantsEnv]);
        return (
          <section key={id}>
            <h2>Connect {provider.name}</h2>
            <p>{provider.connectionHelp}</p>
            {configured ? (
              <form action={connectChannelAction} className="identity-form">
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="provider" value={id} />
                <label htmlFor={`channel-${id}`}>{provider.destinationLabel}</label>
                <input id={`channel-${id}`} name="channel" maxLength={40} required />
                <button type="submit">Connect or refresh {provider.name}</button>
              </form>
            ) : <p>Operator configuration is required.</p>}
          </section>
        );
      })}
    </>
  );
}
