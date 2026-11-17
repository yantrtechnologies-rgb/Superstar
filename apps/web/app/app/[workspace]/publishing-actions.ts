'use server';

import {
  AssetStorageError, beginLinkedInConnection, cancelPost, connectChannel, disconnectLinkedIn, ProviderConfigurationError, PostingSlotUnavailableError, imageLimit, providerIds, providers, savePost, schedulePost,
  transitionPost, WorkspaceAccessError,
} from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../lib/require-user';

const workspace = z.string().regex(/^[a-z0-9-]{1,64}$/);
const post = z.object({ postId: z.uuid(), revision: z.coerce.number().int().positive() });

async function run(form: FormData, page: 'posts' | 'channels', command: (actor: string, slug: string) => Promise<unknown>) {
  const user = await requireUser();
  const scope = workspace.safeParse(form.get('workspace'));
  if (!scope.success) redirect('/app');
  let status = 'saved';
  try {
    await command(user.id, scope.data);
  } catch (error) {
    if (error instanceof z.ZodError) status = 'invalid';
    else if (error instanceof PostingSlotUnavailableError) status = 'slot';
    else if (error instanceof WorkspaceAccessError) status = 'unavailable';
    else if (error instanceof ProviderConfigurationError) status = 'provider';
    else if (error instanceof AssetStorageError) status = 'image';
    else throw error;
  }
  redirect(`/app/${scope.data}/${page}?status=${status}`);
}

function postFields(form: FormData) {
  return post.parse({ postId: form.get('postId'), revision: form.get('revision') });
}

export async function connectChannelAction(form: FormData) {
  await run(form, 'channels', (actor, slug) => {
    const provider = z.enum(providerIds).parse(form.get('provider'));
    const adapter = providers[provider];
    if (adapter.kind !== 'bot') throw new ProviderConfigurationError('Use the provider authorization flow.');
    const channel = z.string().trim().regex(adapter.destinationPattern).parse(form.get('channel'));
    return connectChannel(actor, slug, provider, channel);
  });
}

export async function savePostAction(form: FormData) {
  await run(form, 'posts', async (actor, slug) => {
    const content = z.string().trim().min(1).max(4096).parse(form.get('content'));
    const current = form.has('postId') ? postFields(form) : null;
    const file = form.get('image');
    if (file instanceof File && file.size > imageLimit) throw new AssetStorageError('Image exceeds 2 MiB.');
    const image = file instanceof File && file.size ? new Uint8Array(await file.arrayBuffer()) : undefined;
    return savePost(actor, slug, content, current?.postId, current?.revision, image);
  });
}

export async function submitPostAction(form: FormData) {
  await run(form, 'posts', (actor, slug) => {
    const { postId, revision } = postFields(form);
    const channels = z.array(z.uuid()).min(1).max(20).parse(form.getAll('channel'));
    return transitionPost(actor, slug, postId, revision, 'IN_REVIEW', channels);
  });
}

export async function approvePostAction(form: FormData) {
  await run(form, 'posts', (actor, slug) => {
    const { postId, revision } = postFields(form);
    return transitionPost(actor, slug, postId, revision, 'APPROVED');
  });
}

export async function schedulePostAction(form: FormData) {
  await run(form, 'posts', (actor, slug) => {
    const { postId, revision } = postFields(form);
    const channels = z.array(z.uuid()).min(1).max(20).parse(form.getAll('channel'));
    if (form.get('mode') === 'next') return schedulePost(actor, slug, postId, revision, channels, 'next');
    const publishNow = form.get('mode') === 'now';
    const date = publishNow
      ? new Date()
      : new Date(`${z.iso.datetime({ local: true, precision: -1 }).parse(form.get('dueAt'))}:00Z`);
    if (!publishNow && (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())) {
      throw new WorkspaceAccessError('Choose a future UTC time.');
    }
    return schedulePost(actor, slug, postId, revision, channels, date);
  });
}

export async function cancelPostAction(form: FormData) {
  await run(form, 'posts', (actor, slug) => cancelPost(actor, slug, postFields(form).postId));
}

export async function startLinkedInAction(form: FormData) {
  await run(form, 'channels', async (actor, slug) => redirect(await beginLinkedInConnection(actor, slug)));
}

export async function disconnectLinkedInAction(form: FormData) {
  await run(form, 'channels', async (actor, slug) => {
    await disconnectLinkedIn(actor, slug, z.uuid().parse(form.get('channelId')));
    redirect(`/app/${slug}/channels?status=disconnected`);
  });
}
