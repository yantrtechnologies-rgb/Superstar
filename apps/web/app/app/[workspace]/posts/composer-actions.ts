'use server';

import {
  AssetStorageError, cancelDestination, duplicatePost, imageLimit, PostingSlotUnavailableError, ProviderConfigurationError,
  reschedulePost, saveComposerPost, savePostSet, uploadMedia, videoLimit, WorkspaceAccessError, type ComposerInput,
} from '@cadencedesk/data';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

const slugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
export type ActionResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

function failure(error: unknown): ActionResult<never> {
  if (error instanceof z.ZodError) return { ok: false, error: 'Some fields are invalid. Check the post and try again.' };
  if (error instanceof PostingSlotUnavailableError) return { ok: false, error: 'No free posting slot was found. Pick a time instead.' };
  if (error instanceof WorkspaceAccessError || error instanceof ProviderConfigurationError || error instanceof AssetStorageError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

export async function saveComposerAction(workspace: string, input: ComposerInput): Promise<ActionResult<{ postId: string; state: string }>> {
  const user = await requireUser();
  const slug = slugSchema.parse(workspace);
  try {
    const saved = await saveComposerPost(user.id, slug, input);
    revalidatePath(`/app/${slug}`, 'layout');
    return { ok: true, value: { postId: saved.postId, state: saved.state } };
  } catch (error) {
    return failure(error);
  }
}

export async function uploadMediaAction(workspace: string, form: FormData): Promise<ActionResult<{ id: string; type: string; label: string | null }>> {
  const user = await requireUser();
  const slug = slugSchema.parse(workspace);
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) return { ok: false, error: 'Choose a file to upload.' };
  if (file.size > (file.type === 'video/mp4' ? videoLimit : imageLimit)) {
    return { ok: false, error: 'Images must be under 2 MiB and MP4 videos under 20 MiB.' };
  }
  try {
    const asset = await uploadMedia(user.id, slug, { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type, name: file.name });
    return { ok: true, value: { id: asset.id, type: asset.type, label: asset.label } };
  } catch (error) {
    return failure(error);
  }
}

export async function saveSetAction(workspace: string, name: string, data: Parameters<typeof savePostSet>[3]): Promise<ActionResult<null>> {
  const user = await requireUser();
  try {
    await savePostSet(user.id, slugSchema.parse(workspace), name, data);
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
}

export async function rescheduleAction(workspace: string, postId: string, at: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const slug = slugSchema.parse(workspace);
  try {
    await reschedulePost(user.id, slug, z.uuid().parse(postId), new Date(at));
    revalidatePath(`/app/${slug}`, 'layout');
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
}

export async function duplicateAction(form: FormData) {
  const user = await requireUser();
  const slug = slugSchema.parse(form.get('workspace'));
  const copy = await duplicatePost(user.id, slug, z.uuid().parse(form.get('postId')));
  redirect(`/app/${slug}/posts/${copy.id}/edit?status=duplicated`);
}

export async function cancelDestinationAction(form: FormData) {
  const user = await requireUser();
  const slug = slugSchema.parse(form.get('workspace'));
  let status = 'channel-canceled';
  try {
    await cancelDestination(user.id, slug, z.uuid().parse(form.get('destinationId')));
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    status = 'unavailable';
  }
  redirect(`/app/${slug}/posts?status=${status}`);
}
