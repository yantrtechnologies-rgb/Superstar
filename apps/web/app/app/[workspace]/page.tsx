import { canWritePosts, listChannels, listPosts } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../lib/require-user';

export default async function WorkspaceHome({ params }: { params: Promise<{ workspace: string }> }) {
  const user = await requireUser();
  const { workspace } = await params;
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  const [channels, posts] = await Promise.all([listChannels(user.id, workspace), listPosts(user.id, workspace)]);
  const now = new Date();
  const upcoming = posts.filter((post) => post.scheduledAt && post.scheduledAt > now)
    .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime());
  const drafts = posts.filter(({ state }) => state === 'DRAFT' || state === 'IN_REVIEW').length;
  const published = posts.filter(({ destinations }) => destinations.some(({ state }) => state === 'PUBLISHED')).length;
  const format = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone });
  const base = `/app/${workspace}`;
  return (
    <>
      <header className="page-header">
        <div>
          <h1>{membership.workspace.name}</h1>
          <p>Welcome back · {membership.role.toLowerCase()} · {membership.workspace.timeZone}</p>
        </div>
      </header>
      <div className="stat-grid">
        <div className="stat-card"><span>Connected channels</span><strong>{channels.length}</strong></div>
        <div className="stat-card"><span>Upcoming posts</span><strong>{upcoming.length}</strong></div>
        <div className="stat-card"><span>Drafts and in review</span><strong>{drafts}</strong></div>
        <div className="stat-card"><span>Published</span><strong>{published}</strong></div>
      </div>
      <div className="quick-grid">
        {canWritePosts(membership.role) && (
          <Link className="card-link featured" href={`${base}/posts/new`}><strong>Create a post</strong><span>Write once, pick channels, then schedule or send for review.</span></Link>
        )}
        <Link className="card-link" href={`${base}/calendar`}><strong>Open the calendar</strong><span>See everything planned this week or month.</span></Link>
        <Link className="card-link" href={`${base}/channels`}><strong>{channels.length ? 'Manage channels' : 'Connect your first channel'}</strong><span>Facebook, Instagram, LinkedIn, YouTube, X and more.</span></Link>
        <Link className="card-link" href={`${base}/studio`}><strong>AI Studio</strong><span>Draft copy and generate visuals for your next campaign.</span></Link>
      </div>
      <section className="panel">
        <h2>Coming up next</h2>
        {upcoming.length ? (
          <ul className="post-list">
            {upcoming.slice(0, 5).map((post) => (
              <li key={post.id}>
                <time dateTime={post.scheduledAt!.toISOString()}>{format.format(post.scheduledAt!)}</time>
                <p className="post-content">{post.revisions[0]?.content}</p>
                <p className="muted-line">{post.destinations.map(({ channel }) => channel.name).join(' · ')}</p>
              </li>
            ))}
          </ul>
        ) : <p>Nothing scheduled yet. <Link href={`${base}/posts/new`}>Create a post</Link> and pick a time.</p>}
      </section>
    </>
  );
}
