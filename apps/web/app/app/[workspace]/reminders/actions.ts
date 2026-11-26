'use server';

import { confirmReminder, WorkspaceAccessError } from '@cadencedesk/data';
import { workspaceSlug } from '@cadencedesk/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

export async function confirmReminderAction(form: FormData) {
  const user = await requireUser();
  const workspace = workspaceSlug.safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  let status = 'posted';
  try {
    const link = form.get('link');
    await confirmReminder(user.id, workspace.data, z.uuid().parse(form.get('destinationId')), typeof link === 'string' ? link : undefined);
  } catch (error) {
    if (error instanceof z.ZodError) status = 'link';
    else if (error instanceof WorkspaceAccessError) status = 'unavailable';
    else throw error;
  }
  revalidatePath(`/app/${workspace.data}/reminders`);
  redirect(`/app/${workspace.data}/reminders?status=${status}`);
}
