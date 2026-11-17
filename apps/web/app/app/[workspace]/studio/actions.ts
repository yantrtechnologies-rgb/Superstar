'use server';

import { aiKinds, AiUnavailableError, AssetStorageError, cancelAiJob, CreditBalanceError, queueAiJob, queueClip, queueTranscription, QuoteChangedError, saveStudioVideo, videoLimit, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

async function perform(form: FormData, command: (actor: string, slug: string) => Promise<unknown>) {
  const user = await requireUser();
  const workspace = z.string().regex(/^[a-z0-9-]{1,64}$/).safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  let status = 'saved';
  try {
    await command(user.id, workspace.data);
  } catch (error) {
    if (error instanceof CreditBalanceError) status = 'balance';
    else if (error instanceof QuoteChangedError) status = 'quote';
    else if (error instanceof AiUnavailableError) status = 'config';
    else if (error instanceof AssetStorageError) status = 'asset';
    else if (error instanceof z.ZodError || error instanceof WorkspaceAccessError) status = 'invalid';
    else throw error;
  }
  redirect(`/app/${workspace.data}/studio?status=${status}`);
}

export async function generateAction(form: FormData) {
  await perform(form, (actor, workspace) => queueAiJob(
    actor, workspace, z.enum(aiKinds).parse(form.get('kind')),
    z.string().trim().min(1).max(4000).parse(form.get('prompt')),
    z.coerce.number().int().positive().parse(form.get('credits')),
    z.uuid().parse(form.get('requestId')),
  ));
}

export async function cancelGenerationAction(form: FormData) {
  await perform(form, (actor, workspace) => cancelAiJob(actor, workspace, z.uuid().parse(form.get('id'))));
}

export async function uploadStudioVideoAction(form: FormData) {
  await perform(form, async (actor, workspace) => {
    const video = form.get('video');
    if (!(video instanceof File) || !video.size || video.size > videoLimit) {
      throw new AssetStorageError('Choose an MP4 video up to 20 MiB.');
    }
    return saveStudioVideo(actor, workspace, video.name, new Uint8Array(await video.arrayBuffer()));
  });
}

export async function clipVideoAction(form: FormData) {
  await perform(form, (actor, workspace) => queueClip(
    actor, workspace, z.uuid().parse(form.get('sourceAssetId')),
    z.coerce.number().int().min(0).max(3600).parse(form.get('start')),
    z.coerce.number().int().min(1).max(60).parse(form.get('duration')),
    z.uuid().parse(form.get('requestId')),
  ));
}

export async function transcribeVideoAction(form: FormData) {
  await perform(form, (actor, workspace) => queueTranscription(
    actor, workspace, z.uuid().parse(form.get('sourceAssetId')),
    z.coerce.number().int().positive().parse(form.get('credits')), z.uuid().parse(form.get('requestId')),
  ));
}
