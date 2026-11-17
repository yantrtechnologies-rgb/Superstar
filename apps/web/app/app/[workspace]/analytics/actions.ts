'use server';

import { queueChannelMetric, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

export async function refreshMetricAction(form: FormData) {
  const user = await requireUser();
  const workspace = z.string().regex(/^[a-z0-9-]{1,64}$/).safeParse(form.get('workspace'));
  const channel = z.uuid().safeParse(form.get('channelId'));
  if (!workspace.success || !channel.success) redirect('/app');
  let status = 'queued';
  try {
    const job = await queueChannelMetric(user.id, workspace.data, channel.data);
    if (job.state !== 'QUEUED') status = 'recent';
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    status = 'unavailable';
  }
  redirect(`/app/${workspace.data}/analytics?status=${status}`);
}
