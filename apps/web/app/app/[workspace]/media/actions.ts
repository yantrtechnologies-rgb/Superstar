'use server';

import {
  archiveMedia, AssetStorageError, deletePostSet, deleteSignature, deleteTag, imageLimit, saveSignature, saveTag, updateMedia, uploadMedia,
  videoLimit, WorkspaceAccessError,
} from '@cadencedesk/data';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

const slugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

async function run(form: FormData, page: string, command: (actor: string, slug: string) => Promise<unknown>, done = 'saved') {
  const user = await requireUser();
  const slug = slugSchema.safeParse(form.get('workspace'));
  if (!slug.success) redirect('/app');
  let status = done;
  try {
    await command(user.id, slug.data);
  } catch (error) {
    if (error instanceof z.ZodError) status = 'invalid';
    else if (error instanceof WorkspaceAccessError) status = 'unavailable';
    else if (error instanceof AssetStorageError) status = 'upload';
    else throw error;
  }
  revalidatePath(`/app/${slug.data}`, 'layout');
  redirect(`/app/${slug.data}/${page}?status=${status}`);
}

export async function uploadMediaFormAction(form: FormData) {
  await run(form, 'media', async (actor, slug) => {
    const files = form.getAll('files').filter((file): file is File => file instanceof File && file.size > 0);
    if (!files.length) throw new z.ZodError([]);
    for (const file of files.slice(0, 10)) {
      if (file.size > (file.type === 'video/mp4' ? videoLimit : imageLimit)) throw new AssetStorageError('Too large.');
      await uploadMedia(actor, slug, { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type, name: file.name });
    }
  }, 'uploaded');
}

export async function updateMediaFormAction(form: FormData) {
  await run(form, 'media', (actor, slug) => updateMedia(actor, slug, z.uuid().parse(form.get('id')), {
    alt: String(form.get('alt') ?? '') || null, label: String(form.get('label') ?? '') || null,
  }));
}

export async function archiveMediaFormAction(form: FormData) {
  await run(form, 'media', (actor, slug) => archiveMedia(actor, slug, z.array(z.uuid()).min(1).max(200).parse(form.getAll('id'))), 'archived');
}

export async function saveTagAction(form: FormData) {
  await run(form, 'settings/content', (actor, slug) => saveTag(actor, slug, {
    id: form.get('id') ? z.uuid().parse(form.get('id')) : undefined,
    name: String(form.get('name') ?? ''), color: String(form.get('color') ?? '') || undefined,
  }));
}

export async function deleteTagAction(form: FormData) {
  await run(form, 'settings/content', (actor, slug) => deleteTag(actor, slug, z.uuid().parse(form.get('id'))), 'deleted');
}

export async function saveSignatureAction(form: FormData) {
  await run(form, 'settings/content', (actor, slug) => saveSignature(actor, slug, {
    id: form.get('id') ? z.uuid().parse(form.get('id')) : undefined,
    name: String(form.get('name') ?? ''), content: String(form.get('content') ?? ''), isDefault: form.get('isDefault') === 'on',
  }));
}

export async function deleteSignatureAction(form: FormData) {
  await run(form, 'settings/content', (actor, slug) => deleteSignature(actor, slug, z.uuid().parse(form.get('id'))), 'deleted');
}

export async function deleteSetAction(form: FormData) {
  await run(form, 'settings/content', (actor, slug) => deletePostSet(actor, slug, z.uuid().parse(form.get('id'))), 'deleted');
}
