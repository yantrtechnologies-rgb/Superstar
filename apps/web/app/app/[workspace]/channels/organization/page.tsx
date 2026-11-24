import { canManageTeam, listChannelSettings, postingDays } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../../lib/require-user';
import { addSlotAction, assignGroupAction, createGroupAction, removeSlotAction } from './actions';

const messages: Record<string, string> = {
  'group-created': 'Client group created.',
  'group-assigned': 'Channel group saved.',
  'slot-added': 'Posting slot saved.',
  'slot-removed': 'Posting slot removed.',
  invalid: 'Check your selection and workspace permissions.',
};

function slotTime(minute: number) {
  return [Math.floor(minute / 60), minute % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

export default async function ChannelOrganization({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const [membership, settings] = await Promise.all([getMembership(user.id, workspace), listChannelSettings(user.id, workspace)]);
  if (!membership || !settings) notFound();
  const canManage = canManageTeam(membership.role);
  return (
    <>
      <Link href={`/app/${workspace}/channels`}>Back to channels</Link>
      <h1>Channel groups and posting slots</h1>
      <p>Posting slots use {settings.timeZone}.</p>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {canManage && (
        <form action={createGroupAction} className="identity-form">
          <input type="hidden" name="workspace" value={workspace} />
          <label htmlFor="group-name">Client group name</label>
          <input id="group-name" name="name" maxLength={80} required />
          <button type="submit">Create group</button>
        </form>
      )}
      {settings.clientGroups.length > 0 && (
        <section aria-label="Client groups">
          <h2>Client groups</h2>
          <ul className="workspaces-list">{settings.clientGroups.map((group) => <li key={group.id}>{group.name}</li>)}</ul>
        </section>
      )}
      {settings.channels.length ? <ul className="post-list">{settings.channels.map((channel) => (
        <li key={channel.id}>
          <article>
            <h2>#{channel.name}</h2>
            {canManage ? (
              <form action={assignGroupAction} className="identity-form">
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="channelId" value={channel.id} />
                <label htmlFor={`group-${channel.id}`}>Client group</label>
                <select id={`group-${channel.id}`} name="groupId" defaultValue={channel.clientGroupId ?? ''}>
                  <option value="">Ungrouped</option>
                  {settings.clientGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
                <button type="submit">Save group</button>
              </form>
            ) : <p>{settings.clientGroups.find(({ id }) => id === channel.clientGroupId)?.name ?? 'Ungrouped'}</p>}
            <ul className="workspaces-list">{channel.postingSlots.map((slot) => (
              <li key={slot.id}>
                <span>{postingDays[slot.weekday - 1]} {slotTime(slot.minute)}</span>
                {canManage && (
                  <form action={removeSlotAction}>
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="slotId" value={slot.id} />
                    <button type="submit" aria-label={`Remove ${postingDays[slot.weekday - 1]} ${slotTime(slot.minute)} slot`}>Remove</button>
                  </form>
                )}
              </li>
            ))}</ul>
            {canManage && (
              <form action={addSlotAction} className="identity-form">
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="channelId" value={channel.id} />
                <label htmlFor={`day-${channel.id}`}>Day of week</label>
                <select id={`day-${channel.id}`} name="weekday" defaultValue="1">
                  {postingDays.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
                </select>
                <label htmlFor={`time-${channel.id}`}>Local time</label>
                <input id={`time-${channel.id}`} type="time" name="time" required />
                <button type="submit">Add posting slot</button>
              </form>
            )}
          </article>
        </li>
      ))}</ul> : <p>Connect a channel to set its posting slots.</p>}
    </>
  );
}
