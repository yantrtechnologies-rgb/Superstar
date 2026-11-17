'use server';

import { assignChannelGroup, createClientGroup, removePostingSlot, savePostingSlot, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../../lib/require-user';

const slug = z.string().regex(/^[a-z0-9-]{1,64}$/);

async function update(form: FormData, success: string, command: (userId: string, workspace: string) => Promise<unknown>) {
  const user = await requireUser();
  const scope = slug.safeParse(form.get('workspace'));
  if (!scope.success) redirect('/app');
  let status = success;
  try {
    await command(user.id, scope.data);
  } catch (error) {
    if (!(error instanceof z.ZodError || error instanceof WorkspaceAccessError)) throw error;
    status = 'invalid';
  }
  redirect(`/app/${scope.data}/channels/organization?status=${status}`);
}

export async function createGroupAction(form: FormData) {
  await update(form, 'group-created', (user, workspace) => createClientGroup(user, workspace, z.string().trim().min(1).max(80).parse(form.get('name'))));
}

export async function assignGroupAction(form: FormData) {
  await update(form, 'group-assigned', (user, workspace) => assignChannelGroup(
    user, workspace, z.uuid().parse(form.get('channelId')),
    form.get('groupId') === '' ? null : z.uuid().parse(form.get('groupId')),
  ));
}

export async function addSlotAction(form: FormData) {
  await update(form, 'slot-added', (user, workspace) => {
    const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).parse(form.get('time'));
    const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    return savePostingSlot(user, workspace, z.uuid().parse(form.get('channelId')),
      z.coerce.number().int().min(1).max(7).parse(form.get('weekday')), minute);
  });
}

export async function removeSlotAction(form: FormData) {
  await update(form, 'slot-removed', (user, workspace) => removePostingSlot(user, workspace, z.uuid().parse(form.get('slotId'))));
}
