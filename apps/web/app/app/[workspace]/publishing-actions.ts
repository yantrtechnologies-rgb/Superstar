'use server';

import {
  AssetStorageError, beginLinkedInConnection, beginXConnection, beginYouTubeConnection, cancelPost, connectChannel,
  disconnectLinkedIn, disconnectX, disconnectYouTube, ProviderConfigurationError, PostingSlotUnavailableError,
  approveForChannels, imageLimit, videoLimit, providerIds, providers, savePost, schedulePost,
  transitionPost, WorkspaceAccessError, PlanLimitError,
} from '@cadencedesk/data';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../lib/require-user';

const workspace = z.string().regex(/^[a-z0-9-]{1,64}$/);
const post = z.object({ postId: z.uuid(), revision: z.coerce.number().int().positive() });

async function run(form: FormData, page: 'posts' | 'channels' | 'automations', command: (actor: string, slug: string) => Promise<unknown>) {
  const user = await requireUser();
  const scope = workspace.safeParse(form.get('workspace'));
  if (!scope.success) redirect('/app');
  let status = 'saved';
  let reason = '';
  try {
    await command(user.id, scope.data);
  } catch (error) {
    if (error instanceof z.ZodError) status = 'invalid';
    else if (error instanceof PostingSlotUnavailableError) status = 'slot';
    else if (error instanceof PlanLimitError) status = 'plan-limit';
    else if (error instanceof WorkspaceAccessError) status = 'unavailable';
    else if (error instanceof ProviderConfigurationError) status = 'provider';
    else if (error instanceof AssetStorageError) status = 'image';
    else throw error;
    // The specific reason (for example "Instagram requires an image") is shown next to the general message.
    if (error instanceof WorkspaceAccessError || error instanceof ProviderConfigurationError) reason = error.message.slice(0, 200);
  }
  revalidatePath(`/app/${scope.data}`, 'layout');
  const target = page === 'automations' ? 'automations?tab=awaiting&' : `${page}?`;
  if (page === 'automations' && status === 'saved') status = 'approved';
  redirect(`/app/${scope.data}/${target}status=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);
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
    const file = form.get('media');
    if (file instanceof File && file.size > (file.type === 'video/mp4' ? videoLimit : imageLimit)) {
      throw new AssetStorageError('Attachment exceeds its upload limit.');
    }
    const media = file instanceof File && file.size
      ? { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type } : undefined;
    const followUpText = form.has('followUpText') ? z.string().trim().max(2000).parse(form.get('followUpText')) : undefined;
    const followUp = followUpText === undefined ? undefined : followUpText ? {
      text: followUpText,
      delayMinutes: z.coerce.number().int().min(1).max(10_080).parse(form.get('followUpDelay')),
    } : null;
    return savePost(actor, slug, content, current?.postId, current?.revision, media, followUp);
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

function whenFromForm(form: FormData): Date | 'next' | null {
  const mode = form.get('mode');
  if (mode === 'approve') return null;
  if (mode === 'next') return 'next';
  if (mode === 'now') return new Date();
  const date = new Date(`${z.iso.datetime({ local: true, precision: -1 }).parse(form.get('dueAt'))}:00Z`);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new WorkspaceAccessError('Choose a future UTC time.');
  return date;
}

/** Approve a post awaiting approval for the ticked channels, then post now, schedule, or just approve. */
export async function approveForChannelsAction(form: FormData) {
  await run(form, form.get('back') === 'automations' ? 'automations' : 'posts', (actor, slug) => {
    const { postId, revision } = postFields(form);
    const channels = form.getAll('channel').map(String);
    if (!channels.length) throw new WorkspaceAccessError('Tick at least one channel to post to.');
    return approveForChannels(actor, slug, postId, revision, z.array(z.uuid()).max(20).parse(channels), whenFromForm(form));
  });
}

export async function schedulePostAction(form: FormData) {
  await run(form, 'posts', (actor, slug) => {
    const { postId, revision } = postFields(form);
    if (!form.getAll('channel').length) throw new WorkspaceAccessError('Tick at least one channel to post to.');
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

export async function startOAuthAction(form: FormData) {
  await run(form, 'channels', async (actor, slug) => {
    const provider = z.enum(['linkedin', 'linkedin-pages', 'youtube', 'x']).parse(form.get('provider'));
    const destination = provider === 'linkedin' ? await beginLinkedInConnection(actor, slug)
      : provider === 'linkedin-pages' ? await beginLinkedInConnection(actor, slug, 'pages')
      : provider === 'youtube' ? await beginYouTubeConnection(actor, slug) : await beginXConnection(actor, slug);
    redirect(destination);
  });
}

export async function disconnectOAuthAction(form: FormData) {
  await run(form, 'channels', async (actor, slug) => {
    const provider = z.enum(['linkedin', 'youtube', 'x']).parse(form.get('provider'));
    const channelId = z.uuid().parse(form.get('channelId'));
    if (provider === 'linkedin') await disconnectLinkedIn(actor, slug, channelId);
    else if (provider === 'youtube') await disconnectYouTube(actor, slug, channelId);
    else await disconnectX(actor, slug, channelId);
    redirect(`/app/${slug}/channels?status=disconnected`);
  });
}
