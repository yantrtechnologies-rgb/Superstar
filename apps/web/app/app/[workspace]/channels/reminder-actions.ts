'use server';

import { addReminderChannel, PlanLimitError, removeReminderChannel, WorkspaceAccessError } from '@cadencedesk/data';
import { workspaceSlug } from '@cadencedesk/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

export async function reminderChannelAction(form: FormData) {
  const user = await requireUser();
  const workspace = workspaceSlug.safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  let status = 'reminder-added';
  try {
    if (z.enum(['add', 'remove']).parse(form.get('intent')) === 'add') {
      await addReminderChannel(user.id, workspace.data, {
        name: String(form.get('name') ?? ''), network: String(form.get('network') ?? ''), recipientId: String(form.get('recipientId') ?? ''),
      });
    } else {
      await removeReminderChannel(user.id, workspace.data, z.uuid().parse(form.get('channelId')));
      status = 'reminder-removed';
    }
  } catch (error) {
    if (error instanceof PlanLimitError) status = 'plan-limit';
    else if (error instanceof z.ZodError) status = 'reminder-invalid';
    else if (error instanceof WorkspaceAccessError) status = 'unavailable';
    else throw error;
  }
  revalidatePath(`/app/${workspace.data}`, 'layout');
  redirect(`/app/${workspace.data}/channels?status=${status}`);
}
