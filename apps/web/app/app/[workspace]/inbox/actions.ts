'use server';

import { ProviderConfigurationError, replyToComment, WorkspaceAccessError } from '@cadencedesk/data';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

export async function replyAction(form: FormData) {
  const user = await requireUser();
  const slug = z.string().regex(/^[a-z0-9-]{1,64}$/).safeParse(form.get('workspace'));
  if (!slug.success) redirect('/app');
  const base = `/app/${slug.data}/inbox`;
  let status = 'replied';
  try {
    await replyToComment(
      user.id, slug.data,
      z.uuid().parse(form.get('destinationId')),
      z.string().min(1).max(200).parse(form.get('commentId')),
      z.string().parse(form.get('message')),
    );
  } catch (error) {
    if (error instanceof ProviderConfigurationError || error instanceof WorkspaceAccessError) {
      redirect(`${base}?status=error&message=${encodeURIComponent(error.message.slice(0, 300))}`);
    }
    if (error instanceof z.ZodError) redirect(`${base}?status=invalid`);
    throw error;
  }
  revalidatePath(base);
  redirect(`${base}?status=${status}`);
}
