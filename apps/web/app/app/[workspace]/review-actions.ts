'use server';

import { createReviewLink, revokeReviewLink, WorkspaceAccessError } from '@cadencedesk/data';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../lib/require-user';

type Result = { url: string; message: string };
const slug = z.string().regex(/^[a-z0-9-]{1,64}$/);

export async function issueReviewLinkAction(_previous: Result, form: FormData): Promise<Result> {
  const actor = await requireUser();
  const fields = z.object({
    workspace: slug, postId: z.uuid(), revision: z.coerce.number().int().positive(),
    days: z.coerce.number().int().min(1).max(14),
  }).safeParse(Object.fromEntries(form));
  if (!fields.success || !process.env.APP_URL) return { url: '', message: 'Check the review-link settings and try again.' };
  const { workspace, postId, revision, days } = fields.data;
  try {
    const token = await createReviewLink(actor.id, workspace, postId, revision, days);
    revalidatePath(`/app/${workspace}/posts`);
    return { url: new URL(`/review/${token}`, process.env.APP_URL).href, message: 'Review link created.' };
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    return { url: '', message: 'This draft is no longer available for review.' };
  }
}

export async function revokeReviewLinkAction(form: FormData) {
  const actor = await requireUser();
  const fields = z.object({ workspace: slug, linkId: z.uuid() }).safeParse(Object.fromEntries(form));
  if (!fields.success) redirect('/app');
  const { workspace, linkId } = fields.data;
  try {
    await revokeReviewLink(actor.id, workspace, linkId);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    redirect(`/app/${workspace}/posts?status=unavailable`);
  }
  redirect(`/app/${workspace}/posts?status=saved`);
}
