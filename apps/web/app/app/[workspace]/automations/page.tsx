import { postMediaJobs, aiQueue, aiQueueTabs, type AiQueueTab, aiQuote, canApprovePosts, canManageTeam, feedPresets, canWritePosts, listChannels, listRssRules, rssConfigured } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { ApprovePanel } from '../post-approve';
import { MediaThumb, mediaTypes, PostMediaButtons, postMediaMessages } from '../post-media';
import { addFeedAction, resumeAllFeedsAction, runFeedAction, stopAllFeedsAction, toggleFeedAction } from './actions';

const messages: Record<string, string> = {
  saved: 'Feeds saved. Click Run now on a feed to fetch the newest items; after that each feed is checked every 15 minutes.',
  'no-feed': 'Pick at least one source, or tick "My own feed link" and paste a link.',
  'no-custom': 'You ticked "My own feed link" but the link box is empty.',
  stopped: 'All automations are stopped. No feeds are checked and no AI credits are used until you resume.',
  resumed: 'Automations resumed. Every feed checks for new items now, then every 15 minutes.',
  queued: 'Run requested. Repeated requests in the same five-minute window use the same run.',
  allowlist: 'That feed address was not accepted. Use a public https:// feed address, for example https://example.com/feed.',
  invalid: 'Check the rule, input and your workspace access.',
  approved: 'Done. The post is approved; if you chose post now or a time, it is in Approved & posted and on the Posts page.',
  unavailable: 'That could not be done.',
  provider: 'This post does not suit one of the chosen channels.',
  slot: 'No free posting slot was found for those channels. Pick a time instead, or add posting slots on the Channels page.',
  'plan-limit': 'Your plan limit was reached. Upgrade on the Billing page.',
  image: 'An attached file is not available. Remove it or create a new AI image.',
  ...postMediaMessages,
};

const tabHelp: Record<AiQueueTab, string> = {
  queued: 'New articles waiting for the AI writer. Each feed sends up to 3 at a time, every 15 minutes.',
  writing: 'The AI is reading these articles and writing posts right now. This usually takes under a minute.',
  awaiting: 'Posts the AI wrote for you. Read the suggestions, edit if needed, then approve.',
  approved: 'Posts you approved: scheduled, posted, or waiting for you to pick a time on the Posts page.',
  skipped: 'Articles the AI judged not to be about your topic. No post was written.',
  failed: 'Articles the AI could not finish. Credits for these were returned.',
};

export default async function Automations({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string; tab?: string; reason?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status, tab: rawTab, reason }] = await Promise.all([params, searchParams]);
  const [membership, rules, channels, queue] = await Promise.all([
    getMembership(user.id, workspace), listRssRules(user.id, workspace), listChannels(user.id, workspace), aiQueue(user.id, workspace),
  ]);
  if (!membership) notFound();
  const tab = aiQueueTabs.find(({ id }) => id === rawTab)?.id ?? null;
  const nav = (
    <nav className="segmented" aria-label="Automation views">
      <Link href="?" aria-current={!tab ? 'page' : undefined}>Feeds <small>{rules.length}</small></Link>
      {aiQueueTabs.map(({ id, label }) => (
        <Link key={id} href={`?tab=${id}`} aria-current={tab === id ? 'page' : undefined}>{label} <small>{queue.tabs[id].length}</small></Link>
      ))}
    </nav>
  );
  const running = rules.filter(({ enabled }) => enabled).length;
  const controls = rules.length > 0 && (
    <section className={'automation-switch ' + (running ? 'is-on' : 'is-off')}>
      <p>
        <strong>{running ? `Automations are running: ${running} of ${rules.length} feeds active.` : 'Automations are stopped.'}</strong>{' '}
        {running ? 'Feeds are checked every 15 minutes and new items use AI credits.' : 'No feeds are checked and no AI credits are used.'}
        {queue.tabs.queued.length > 0 && ` ${queue.tabs.queued.length} queued item${queue.tabs.queued.length === 1 ? '' : 's'} ${running ? 'will be written next' : 'will wait until you resume'}.`}
      </p>
      {canManageTeam(membership.role) && <div className="row-actions">
        {running > 0 && <form action={stopAllFeedsAction}>
          <input type="hidden" name="workspace" value={workspace} />
          <button type="submit" className="btn btn-danger">⏹ Stop all automations</button>
        </form>}
        {running < rules.length && <form action={resumeAllFeedsAction}>
          <input type="hidden" name="workspace" value={workspace} />
          <button type="submit" className="btn">▶ {running ? 'Resume paused feeds' : 'Resume automations'}</button>
        </form>}
      </div>}
    </section>
  );
  if (tab) {
    const items = queue.tabs[tab];
    const [mediaJobs, types] = await Promise.all([
      postMediaJobs(user.id, workspace), mediaTypes(items.flatMap((item) => item.post?.revisions[0]?.mediaIds ?? [])),
    ]);
    const when = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone });
    const canApprove = canApprovePosts(membership.role);
    return (
      <>
        <h1>Automations</h1>
        {nav}
        {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}{reason && status !== 'saved' ? ` ${reason}` : ''}</p>}
        {controls}
        <p className="muted-line">{tabHelp[tab]}{tab === 'skipped' && queue.olderSkipped > 0 && ` ${queue.olderSkipped} older articles were also passed over without AI (only the newest ones per check are used).`}</p>
        {(tab === 'queued' || tab === 'writing') && items.length > 0 && <p><Link className="btn" href={`?tab=${tab}`}>Refresh</Link></p>}
        {items.length ? <ul className="post-list">{items.map((item) => {
          const revision = item.post?.revisions[0];
          return (
            <li key={item.ruleId + item.sourceKey}>
              <article id={item.post ? `post-${item.post.id}` : undefined}>
                <h2 className="post-head">
                  <span className={'badge ' + (({ awaiting: 'badge-warn', approved: 'badge-ok', failed: 'badge-bad' } as Record<string, string>)[tab] ?? 'badge-muted')}>{aiQueueTabs.find(({ id }) => id === tab)?.label}</span>
                  <small>{item.rule.name} · {when.format(item.importedAt)}</small>
                </h2>
                <p><strong>{item.title ?? 'Feed article'}</strong></p>
                {item.aiNote && <p className="muted-line">{item.aiNote}</p>}
                {revision && <p className="post-content">{revision.content}</p>}
                {revision && revision.mediaIds.length > 0 && (
                  <div className="media-strip small">
                    {revision.mediaIds.slice(0, 4).map((id) => <MediaThumb key={id} className="queue-thumb" src={`/app/${workspace}/media/${id}`} type={types.get(id)} />)}
                  </div>
                )}
                {tab === 'awaiting' && canApprove && item.post?.state === 'IN_REVIEW' && (
                  <ApprovePanel workspace={workspace} postId={item.post.id} revision={item.post.revision} channels={channels}
                    checked={item.post.revisions[0]?.channelIds ?? []} back="automations" earliest={new Date(Date.now() + 60_000).toISOString().slice(0, 16)} />
                )}
                {item.post && <PostMediaButtons workspace={workspace} postId={item.post.id} state={item.post.state} jobs={mediaJobs.get(item.post.id) ?? []} back="automations" />}
                {item.post?.aiNote && (
                  <details className="ai-note" open={tab === 'awaiting'}>
                    <summary>✨ AI suggestions</summary>
                    <p style={{ whiteSpace: 'pre-line' }}>{item.post.aiNote}</p>
                  </details>
                )}
                {item.post && <div className="row-actions">
                  {tab === 'awaiting' && <Link className="btn" href={`/app/${workspace}/posts/${item.post.id}/edit`}>Edit</Link>}
                  <Link className="btn" href={`/app/${workspace}/posts#post-${item.post.id}`}>Open in Posts</Link>
                  {item.post.destinations.filter(({ permalink }) => permalink).map(({ permalink }) => (
                    <a key={permalink} className="btn" href={permalink!} target="_blank" rel="noreferrer">View live post</a>
                  ))}
                </div>}
              </article>
            </li>
          );
        })}</ul> : <section className="panel"><p>Nothing here right now.</p></section>}
      </>
    );
  }
  const canManage = canManageTeam(membership.role);
  const canRun = canWritePosts(membership.role);
  const textQuote = aiQuote('TEXT');
  const imageQuote = aiQuote('IMAGE');
  const perCheck = Number(process.env.RSS_AI_ITEMS_PER_CHECK ?? 3) || 3;
  const format = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone });
  return (
    <>
      <h1>Automations</h1>
      {nav}
      {controls}
      {canManage && <Link href={`/app/${workspace}/automations/webhooks`}>Manage outbound webhooks</Link>}
      <h2>RSS publishing rules</h2>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {canManage && (rssConfigured() ? (
        <form action={addFeedAction} className="identity-form">
          <input type="hidden" name="workspace" value={workspace} />
          <label htmlFor="feed-topic">Your topic of interest</label>
          <input id="feed-topic" name="aiTopic" maxLength={300} required placeholder="Digital marketing tips for small businesses in India" />
          <p className="muted-line">
            Google News and Bing News search for this topic{textQuote ? ', and the AI keeps only items about it when it writes your posts' : ''}.
          </p>

          <fieldset className="feed-choices">
            <legend>Where should posts come from? Pick one or more</legend>
            {feedPresets.map((preset) => (
              <label key={preset.id} className="channel-choice feed-choice">
                <input type="checkbox" name="preset" value={preset.id} defaultChecked={preset.id === 'google-news'} />
                <span><strong>{preset.name}</strong><small>{preset.note}</small></span>
              </label>
            ))}
            <label className="channel-choice feed-choice">
              <input type="checkbox" name="useCustom" value="yes" />
              <span><strong>My own feed link</strong><small>Any blog, news site or YouTube channel feed.</small></span>
            </label>
            <label htmlFor="feed-url" className="sr-only">Your feed link</label>
            <input id="feed-url" name="url" type="url" maxLength={2048} placeholder="https://example.com/feed" />
            <p className="muted-line">
              WordPress sites use <code>/feed</code>, Blogger uses <code>/feeds/posts/default</code>, and a YouTube channel&apos;s
              feed is <code>https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID</code>. Each source is checked every 15 minutes.
            </p>
          </fieldset>

          {textQuote && <fieldset>
            <legend>AI writer</legend>
            <p className="muted-line">
              Each new item is checked against your topic: off-topic items are skipped, and the rest are written as ready-to-review
              posts with suggestions (why it matters, when to post, other angles). Nothing is published until you approve it.
            </p>
            <label htmlFor="ai-instructions">Brand, audience and tone (optional)</label>
            <textarea id="ai-instructions" name="aiInstructions" rows={3} maxLength={1500}
              placeholder="We are Xolnet Technologies: digital marketing, IT products and IT training. Friendly, practical tone; speak to business owners; end with a question." />
            {imageQuote && <label className="channel-choice">
              <input type="checkbox" name="aiImage" value="yes" /> Also create a matching image for each post (+{imageQuote.credits} credits per post; needed for Instagram)
            </label>}
            <p className="muted-line">
              Cost: {textQuote.credits} credit{textQuote.credits === 1 ? '' : 's'} per item checked{imageQuote ? `, plus ${imageQuote.credits} for each image` : ''}.
              Up to {perCheck} new items per source per check. <Link href={`/app/${workspace}/billing`}>Buy credits</Link>
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
          <button type="submit" className="primary">Start these feeds</button>
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
