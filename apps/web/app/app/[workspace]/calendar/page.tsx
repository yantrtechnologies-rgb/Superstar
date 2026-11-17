import { findMembership, listPosts } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';

export default async function Calendar({ params }: { params: Promise<{ workspace: string }> }) {
  const user = await requireUser();
  const { workspace } = await params;
  const membership = await findMembership(user.id, workspace);
  if (!membership) notFound();
  const posts = await listPosts(user.id, workspace, true);
  const format = new Intl.DateTimeFormat('en', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone,
  });
  return (
    <>
      <h1>Publishing agenda</h1>
      <p>{membership.workspace.timeZone}</p>
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
