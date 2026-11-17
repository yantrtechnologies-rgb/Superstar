import { findMembership, listChannelSettings, listPosts } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';

export default async function Calendar({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ group?: string }> }) {
  const user = await requireUser();
  const { workspace } = await params;
  const membership = await findMembership(user.id, workspace);
  if (!membership) notFound();
  const [{ group }, settings] = await Promise.all([searchParams, listChannelSettings(user.id, workspace)]);
  const groups = settings?.clientGroups ?? [];
  const selected = groups.find(({ id }) => id === group)?.id;
  const posts = await listPosts(user.id, workspace, true, selected);
  const format = new Intl.DateTimeFormat('en', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone,
  });
  return (
    <>
      <h1>Publishing agenda</h1>
      <p>{membership.workspace.timeZone}</p>
      {groups.length > 0 && (
        <form className="identity-form" method="get">
          <label htmlFor="group">Client group</label>
          <select id="group" name="group" defaultValue={selected ?? ''}>
            <option value="">All groups</option>
            {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button type="submit">Filter agenda</button>
        </form>
      )}
      {posts.length ? <ul className="post-list">{posts.map((post) => (
        <li key={post.id}>
          {post.scheduledAt && <time dateTime={post.scheduledAt.toISOString()}>{format.format(post.scheduledAt)}</time>}
          <p className="post-content">{post.revisions[0]?.content}</p>
          <p>{post.destinations.map(({ channel, state }) => `#${channel.name} · ${state.toLowerCase()}`).join(', ')}</p>
        </li>
      ))}</ul> : <p>No scheduled posts yet.</p>}
      <Link href={`/app/${workspace}/posts`}>Manage posts</Link>
    </>
  );
}
