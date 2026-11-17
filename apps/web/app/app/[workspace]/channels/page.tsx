import { canManageTeam, findMembership, listChannels } from '@cadencedesk/data';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { connectDiscordAction } from '../publishing-actions';

const messages: Record<string, string> = {
  saved: 'Channel connected.',
  invalid: 'Enter a valid Discord channel ID.',
  unavailable: 'You do not have access to connect this channel.',
  discord: 'Check the workspace channel grant, bot configuration and Discord access.',
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
          {channels.map((channel) => <li key={channel.id}><span>#{channel.name}</span><span>Discord</span></li>)}
        </ul>
      ) : <p>No channels are connected yet.</p>}
      {canManageTeam(membership.role) && (
        <section>
          <h2>Connect a Discord channel</h2>
          {process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_WORKSPACE_CHANNELS ? (
            <form action={connectDiscordAction} className="identity-form">
              <input type="hidden" name="workspace" value={workspace} />
              <label htmlFor="channel">Server text channel ID</label>
              <input id="channel" name="channel" inputMode="numeric" pattern="[0-9]{17,20}" required />
              <p>Your operator must grant this workspace access to the channel and install the bot.</p>
              <button type="submit">Connect channel</button>
            </form>
          ) : <p>Ask your operator to configure a Discord bot and workspace channel grants.</p>}
        </section>
      )}
    </>
  );
}
