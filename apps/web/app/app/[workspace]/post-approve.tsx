import { approveForChannelsAction } from './publishing-actions';

type Channel = { id: string; name: string; provider: string };

const networkNames: Record<string, string> = {
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', youtube: 'YouTube', telegram: 'Telegram', discord: 'Discord',
};

/** Tick boxes for the channels a post should go to. */
export function ChannelPicker({ channels, checked, idPrefix }: { channels: Channel[]; checked: string[]; idPrefix: string }) {
  return (
    <fieldset className="channel-picker">
      <legend>Post to</legend>
      {channels.map((channel) => (
        <label key={channel.id} className="channel-choice channel-pill" htmlFor={`${idPrefix}-${channel.id}`}>
          <input id={`${idPrefix}-${channel.id}`} type="checkbox" name="channel" value={channel.id} defaultChecked={checked.includes(channel.id)} />
          <span className="channel-avatar" data-provider={channel.provider} aria-hidden="true">{channel.name.slice(0, 1)}</span>
          {channel.name} <small>{networkNames[channel.provider] ?? channel.provider}</small>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * For a post awaiting approval: pick the channels, then approve and post now, schedule, use the next free slot,
 * or approve only (and schedule later from the Posts page).
 */
export function ApprovePanel({ workspace, postId, revision, channels, checked, back, earliest }: {
  workspace: string; postId: string; revision: number; channels: Channel[]; checked: string[];
  back: 'posts' | 'automations'; earliest: string;
}) {
  if (!channels.length) return <p className="muted-line">Connect a channel on the Channels page to post this.</p>;
  return (
    <form action={approveForChannelsAction} className="identity-form schedule-panel">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="revision" value={revision} />
      <input type="hidden" name="back" value={back} />
      <h3>Approve and post</h3>
      <ChannelPicker channels={channels} checked={checked} idPrefix={`approve-${postId}`} />
      <label htmlFor={`approve-due-${postId}`}>Date and time for &ldquo;Approve &amp; schedule&rdquo; (UTC)</label>
      <input type="datetime-local" id={`approve-due-${postId}`} name="dueAt" min={earliest} />
      <div className="post-actions">
        <button type="submit" name="mode" value="now" className="btn btn-primary">Approve &amp; post now</button>
        <button type="submit" name="mode" value="schedule" className="btn">Approve &amp; schedule</button>
        <button type="submit" name="mode" value="next" className="btn">Approve &amp; use next free slot</button>
        <button type="submit" name="mode" value="approve" className="btn">Approve only</button>
      </div>
    </form>
  );
}
