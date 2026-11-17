import { canManageTeam, canWritePosts, findMembership, listRssRules, rssConfigured } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { addFeedAction, runFeedAction, toggleFeedAction } from './actions';

const messages: Record<string, string> = {
  saved: 'RSS rule saved.',
  queued: 'Run requested. Repeated requests in the same five-minute window use the same run.',
  allowlist: 'Ask your operator to allow the exact HTTPS feed URL.',
  invalid: 'Check the rule, input and your workspace access.',
};

export default async function Automations({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const [membership, rules] = await Promise.all([findMembership(user.id, workspace), listRssRules(user.id, workspace)]);
  if (!membership) notFound();
  const canManage = canManageTeam(membership.role);
  const canRun = canWritePosts(membership.role);
  const format = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone });
  return (
    <>
      <h1>Automations</h1>
      {canManage && <Link href={`/app/${workspace}/automations/webhooks`}>Manage outbound webhooks</Link>}
      <h2>RSS-to-draft rules</h2>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {canManage && (rssConfigured() ? (
        <form action={addFeedAction} className="identity-form">
          <input type="hidden" name="workspace" value={workspace} />
          <label htmlFor="feed-name">Rule name</label>
          <input id="feed-name" name="name" maxLength={80} required />
          <label htmlFor="feed-url">Approved HTTPS feed URL</label>
          <input id="feed-url" name="url" type="url" maxLength={2048} required />
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
                <span>{run.state.toLowerCase()}{run.state === 'COMPLETED' ? ` · ${run.imported} drafts` : ''}</span>
                {run.error && <p>{run.error}</p>}
              </li>
            ))}</ul>}
          </article>
        </li>
      ))}</ul> : <p>No RSS rules yet.</p>}
    </>
  );
}
