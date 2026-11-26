import {
  canApprovePosts, canWritePosts, composerProviders, listChannels, listChannelSettings, listContentSettings, listMedia, loadComposerPost,
  postSetData,
} from '@cadencedesk/data';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { Composer, type ComposerInitial } from './composer';

const statusText: Record<string, string> = { duplicated: 'Copy created as a new draft. Edit it and schedule when ready.' };

export async function ComposerPage({ workspace, postId, status }: { workspace: string; postId?: string; status?: string }) {
  const user = await requireUser();
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  if (!canWritePosts(membership.role)) redirect(`/app/${workspace}/posts`);
  const [channels, settings, media, content, existing] = await Promise.all([
    listChannels(user.id, workspace),
    listChannelSettings(user.id, workspace),
    listMedia(user.id, workspace),
    listContentSettings(user.id, workspace),
    postId ? loadComposerPost(user.id, workspace, postId) : Promise.resolve(null),
  ]);
  if (postId && !existing) notFound();
  const editable = !existing || ['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(existing.state);
  const defaultSignature = content.signatures.find(({ isDefault }) => isDefault);
  const initial: ComposerInitial = existing ? {
    id: existing.id, revision: existing.revision, channelIds: existing.channelIds, content: existing.content, overrides: existing.overrides,
    formats: existing.formats, thread: existing.thread, mediaIds: existing.mediaIds, tagIds: existing.tagIds, repeatEveryDays: existing.repeatEveryDays,
    scheduledAt: existing.scheduledAt?.toISOString() ?? null,
  } : {
    channelIds: [], content: defaultSignature ? `\n\n${defaultSignature.content}` : '', overrides: {}, thread: [], mediaIds: [], tagIds: [],
    repeatEveryDays: null,
  };
  return (
    <>
      <header className="page-header">
        <div>
          <h1>{existing ? 'Edit post' : 'Create post'}</h1>
          <p>{existing ? `Revision ${existing.revision} · ${existing.state.replaceAll('_', ' ').toLowerCase()}` : 'Write once, then tailor it per channel.'}</p>
        </div>
        <Link className="btn" href={`/app/${workspace}/posts`}>Back to posts</Link>
      </header>
      {status && Object.hasOwn(statusText, status) && <p role="status">{statusText[status]}</p>}
      {editable ? (
        <Composer
          workspace={workspace}
          channels={channels.map(({ id, name, provider, clientGroupId }) => ({ id, name, provider, groupId: clientGroupId }))}
          groups={(settings?.clientGroups ?? []).map(({ id, name }) => ({ id, name }))}
          providers={composerProviders()}
          media={media.map(({ id, type, label, alt }) => ({ id, type, label, alt }))}
          tags={content.tags.map(({ id, name, color }) => ({ id, name, color }))}
          signatures={content.signatures.map(({ id, name, content: text, isDefault }) => ({ id, name, content: text, isDefault }))}
          sets={content.postSets.flatMap(({ id, name, data }) => {
            const parsed = postSetData.safeParse(data);
            return parsed.success ? [{ id, name, data: parsed.data }] : [];
          })}
          initial={initial}
          canApprove={canApprovePosts(membership.role)}
          timeZone={membership.workspace.timeZone}
        />
      ) : (
        <section className="panel">
          <p>This post is {existing?.state.toLowerCase()} and can no longer be edited. Duplicate it from the posts list to make a new version.</p>
        </section>
      )}
    </>
  );
}
