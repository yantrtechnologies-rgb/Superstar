import { canWritePosts, findMembership, getProvider, workspaceMetrics } from '@cadencedesk/data';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireUser } from '../../../../lib/require-user';
import { refreshMetricAction } from './actions';

const messages: Record<string, string> = {
  queued: 'Refresh queued. Open the latest results to check progress.',
  recent: 'A refresh already ran in the current five-minute window.',
  unavailable: 'This channel cannot be refreshed from your account.',
};

export default async function Analytics({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ days?: string; status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { days, status }] = await Promise.all([params, searchParams]);
  const membership = await findMembership(user.id, workspace);
  if (!membership) notFound();
  const windowDays = days === '7' || days === '90' ? Number(days) : 30;
  const channels = await workspaceMetrics(user.id, workspace, new Date(Date.now() - windowDays * 86_400_000));
  const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone });
  const number = new Intl.NumberFormat('en');
  return (
    <>
      <h1>Analytics</h1>
      <form className="identity-form" method="get">
        <label htmlFor="days">Date range</label>
        <select id="days" name="days" defaultValue={windowDays}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button type="submit">Apply date range</button>
      </form>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {channels.some(({ metricJobs }) => metricJobs[0]?.state === 'QUEUED') &&
        <Link href={`/app/${workspace}/analytics?days=${windowDays}`}>Check refresh status</Link>}
      {channels.length ? <ul className="post-list">{channels.map((channel) => {
        const supported = channel.provider === 'telegram';
        const history = channel.snapshots;
        const latest = history[0];
        const job = channel.metricJobs[0];
        return (
          <li key={channel.id}>
            <article>
              <h2>{channel.name}</h2>
              <p>{getProvider(channel.provider)?.name ?? channel.provider}</p>
              {supported ? (
                <>
                  <p>Members · {latest ? number.format(latest.count) : 'Unavailable for this date range'}</p>
                  {job?.state === 'QUEUED' && <p>Refresh queued</p>}
                  {job?.state === 'UNAVAILABLE' && <p>{job.error}</p>}
                  {history.length > 0 && (
                    <ul className="workspaces-list">{history.map((snapshot) => (
                      <li key={snapshot.id}>
                        <time dateTime={snapshot.observedAt.toISOString()}>{date.format(snapshot.observedAt)}</time>
                        <span>{number.format(snapshot.count)} members</span>
                      </li>
                    ))}</ul>
                  )}
                  {canWritePosts(membership.role) && (
                    <form action={refreshMetricAction}>
                      <input type="hidden" name="workspace" value={workspace} />
                      <input type="hidden" name="channelId" value={channel.id} />
                      <button type="submit">Refresh member count</button>
                    </form>
                  )}
                </>
              ) : <p>Metrics are unavailable for this provider.</p>}
            </article>
          </li>
        );
      })}</ul> : <p>Connect channels to see their metric coverage.</p>}
    </>
  );
}
