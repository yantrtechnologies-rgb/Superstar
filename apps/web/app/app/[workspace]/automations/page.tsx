import { aiQuote, canManageTeam, canWritePosts, listChannels, listRssRules, rssConfigured } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { addFeedAction, runFeedAction, toggleFeedAction } from './actions';

const messages: Record<string, string> = {
  saved: 'RSS rule saved. Click Run now to fetch the newest items; after that the feed is checked every 15 minutes.',
  queued: 'Run requested. Repeated requests in the same five-minute window use the same run.',
  allowlist: 'That feed address was not accepted. Use a public https:// feed address, for example https://example.com/feed.',
  invalid: 'Check the rule, input and your workspace access.',
};

export default async function Automations({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const [membership, rules, channels] = await Promise.all([
    getMembership(user.id, workspace), listRssRules(user.id, workspace), listChannels(user.id, workspace),
  ]);
  if (!membership) notFound();
  const canManage = canManageTeam(membership.role);
  const canRun = canWritePosts(membership.role);
  const textQuote = aiQuote('TEXT');
  const imageQuote = aiQuote('IMAGE');
  const perCheck = Number(process.env.RSS_AI_ITEMS_PER_CHECK ?? 3) || 3;
  const format = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone });
  return (
    <>
      <h1>Automations</h1>
      {canManage && <Link href={`/app/${workspace}/automations/webhooks`}>Manage outbound webhooks</Link>}
      <h2>RSS publishing rules</h2>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {canManage && (rssConfigured() ? (
        <form action={addFeedAction} className="identity-form">
          <input type="hidden" name="workspace" value={workspace} />
          <label htmlFor="feed-name">Rule name</label>
          <input id="feed-name" name="name" maxLength={80} required />
          <label htmlFor="feed-url">Feed address (https://)</label>
          <input id="feed-url" name="url" type="url" maxLength={2048} required placeholder="https://example.com/feed" />
          <p className="muted-line">
            Most blogs have one: WordPress sites use <code>/feed</code>, Blogger uses <code>/feeds/posts/default</code>, and a YouTube
            channel&apos;s feed is <code>https://www.youtube.com/feeds/videos.xml?channel_id=YOUR_CHANNEL_ID</code>.
            New items are checked every 15 minutes.
          </p>
          {textQuote && <fieldset>
            <legend>AI writer (optional)</legend>
            <p className="muted-line">
              Fill in a topic and every new item goes through AI first: items that are not about your topic are skipped, and
              the rest are rewritten as ready-to-review posts with suggestions (why it matters, when to post, other angles).
              Nothing is published until you approve it.
            </p>
            <label htmlFor="ai-topic">Topic to keep</label>
            <input id="ai-topic" name="aiTopic" maxLength={300} placeholder="Digital marketing tips for small businesses in India" />
            <label htmlFor="ai-instructions">Brand, audience and tone</label>
            <textarea id="ai-instructions" name="aiInstructions" rows={3} maxLength={1500}
              placeholder="We are Xolnet Technologies: digital marketing, IT products and IT training. Friendly, practical tone; speak to business owners; end with a question." />
            {imageQuote && <label className="channel-choice">
              <input type="checkbox" name="aiImage" value="yes" /> Also create a matching image for each post (+{imageQuote.credits} credits per post; needed for Instagram)
            </label>}
            <p className="muted-line">
              Cost: {textQuote.credits} credit{textQuote.credits === 1 ? '' : 's'} per item checked{imageQuote ? `, plus ${imageQuote.credits} for each image` : ''}.
              Up to {perCheck} new items per check. <Link href={`/app/${workspace}/billing`}>Buy credits</Link>
            </p>
          </fieldset>}
          {channels.length > 0 && <fieldset>
            <legend>Channels for the new posts</legend>
            {channels.map((channel) => <label key={channel.id} className="channel-choice">
              <input type="checkbox" name="channel" value={channel.id} /> {channel.name} ({channel.provider})
            </label>)}
            <label className="channel-choice">
              <input type="checkbox" name="publishAfterApproval" value="yes" /> After I approve a post, schedule it automatically in the channels&apos; next free posting slot
            </label>
          </fieldset>}
          <button type="submit">Add RSS rule</button>
        </form>
      ) : <p>Ask your operator to configure approved RSS feeds.</p>)}
      {rules.some(({ runs }) => runs.some(({ state }) => state === 'QUEUED')) &&
        <Link href={`/app/${workspace}/automations?status=refresh`}>Check run status</Link>}
      {rules.length ? <ul className="post-list">{rules.map((rule) => (
        <li key={rule.id}>
          <article>
            <h2>{rule.name}</h2>
            <p>{rule.sourceUrl}</p>
            <p>{rule.enabled ? 'Enabled · every 15 minutes' : 'Paused'}</p>
            {rule.aiTopic && <p><strong>AI writer:</strong> keeps items about &ldquo;{rule.aiTopic}&rdquo;{rule.aiImage ? ', with an image' : ''}. New posts wait in <Link href={`/app/${workspace}/posts?state=IN_REVIEW`}>Posts → In review</Link>.</p>}
            <p>{rule.publishAfterApproval ? 'Approved posts are scheduled automatically in the next free slot' : rule.aiTopic ? 'You approve each post, then post or schedule it' : 'Import as drafts'}</p>
            {rule.channelIds.length > 0 && <p>Channels: {channels.filter(({ id }) => rule.channelIds.includes(id)).map(({ name }) => name).join(', ')}</p>}
            {rule.aiTopic && rule.imports.some(({ aiState }) => aiState) && <ul className="workspaces-list" aria-label="AI writer results">
              {rule.imports.filter(({ aiState }) => aiState).map((item) => (
                <li key={item.sourceKey}>
                  <span>{item.title ?? 'Feed item'}</span>
                  <span className={'badge ' + ({ DONE: 'badge-ok', SKIPPED: 'badge-muted', FAILED: 'badge-bad' }[item.aiState ?? ''] ?? 'badge-warn')}>
                    {{ DONE: 'Post written', SKIPPED: 'Skipped', FAILED: 'Failed', PENDING: 'Writing…' }[item.aiState ?? ''] ?? item.aiState}
                  </span>
                  {item.aiState === 'DONE' && item.postId && <Link href={`/app/${workspace}/posts#post-${item.postId}`}>Review post</Link>}
                  {item.aiNote && <p className="muted-line">{item.aiNote}</p>}
                </li>
              ))}
            </ul>}
            {!rule.aiTopic && rule.imports.length > 0 && <ul className="workspaces-list" aria-label="Feed publishing status">
              {rule.imports.map((item) => (
                <li key={item.sourceKey}>
                  <span>{item.post?.state === 'CANCELED' ? 'Canceled'
                    : item.post?.scheduledAt ? `Scheduled for ${format.format(item.post.scheduledAt)}`
                    : item.scheduleState === 'BLOCKED' ? 'Scheduling blocked'
                    : item.post?.state === 'APPROVED' ? 'Awaiting a shared slot'
                    : item.post?.state === 'DRAFT' ? 'Draft needs review preparation' : 'Awaiting review'}</span>
                  {item.scheduleError && <p>{item.scheduleError}</p>}
                </li>
              ))}
            </ul>}
            {canRun && rule.enabled && <form action={runFeedAction}>
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="id" value={rule.id} />
              <button type="submit">Run now</button>
            </form>}
            {canManage && <form action={toggleFeedAction}>
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="id" value={rule.id} />
              <input type="hidden" name="enabled" value={rule.enabled ? 'no' : 'yes'} />
              <button type="submit">{rule.enabled ? 'Pause rule' : 'Enable rule'}</button>
            </form>}
            {rule.runs.length > 0 && <ul className="workspaces-list" aria-label="Recent runs">{rule.runs.map((run) => (
              <li key={run.id}>
                <time dateTime={run.createdAt.toISOString()}>{format.format(run.createdAt)}</time>
                <span>{run.state.toLowerCase()}{run.state === 'COMPLETED' ? ` · ${run.imported} ${rule.aiTopic ? 'new items for AI' : 'drafts'}` : ''}</span>
                {run.error && <p>{run.error}</p>}
              </li>
            ))}</ul>}
          </article>
        </li>
      ))}</ul> : <p>No RSS rules yet.</p>}
    </>
  );
}
