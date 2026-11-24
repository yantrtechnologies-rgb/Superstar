'use server';

import { AiUnavailableError, CreditBalanceError, queuePostMedia, QuoteChangedError, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../lib/require-user';

/** Starts an AI image or video for a post; the result is attached to the post when it is ready. */
export async function createPostMediaAction(form: FormData) {
  const user = await requireUser();
  const workspace = z.string().regex(/^[a-z0-9-]{1,64}$/).safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  const back = form.get('back') === 'automations' ? `automations?tab=awaiting&` : 'posts?';
  const postId = z.uuid().safeParse(form.get('postId'));
  let status = 'media-started';
  try {
    if (!postId.success) throw new WorkspaceAccessError('That post is unavailable.');
    await queuePostMedia(
      user.id, workspace.data, postId.data, z.enum(['IMAGE', 'VIDEO']).parse(form.get('kind')),
      z.coerce.number().int().positive().parse(form.get('credits')),
    );
  } catch (error) {
    if (error instanceof CreditBalanceError) status = 'media-balance';
    else if (error instanceof QuoteChangedError) status = 'media-quote';
    else if (error instanceof AiUnavailableError) status = 'media-config';
    else if (error instanceof z.ZodError || error instanceof WorkspaceAccessError) status = 'media-invalid';
    else throw error;
  }
  redirect(`/app/${workspace.data}/${back}status=${status}${postId.success ? `#post-${postId.data}` : ''}`);
}
