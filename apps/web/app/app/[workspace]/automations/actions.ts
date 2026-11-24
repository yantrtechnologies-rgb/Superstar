'use server';

import { addRssRule, queueRssRun, RssConfigurationError, setRssEnabled, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

async function perform(form: FormData, success: string, command: (actor: string, workspace: string) => Promise<unknown>) {
  const user = await requireUser();
  const workspace = z.string().regex(/^[a-z0-9-]{1,64}$/).safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  let status = success;
  try {
    await command(user.id, workspace.data);
  } catch (error) {
    if (error instanceof RssConfigurationError) status = 'allowlist';
    else if (error instanceof z.ZodError || error instanceof WorkspaceAccessError) status = 'invalid';
    else throw error;
  }
  redirect(`/app/${workspace.data}/automations?status=${status}`);
}

export async function addFeedAction(form: FormData) {
  await perform(form, 'saved', (actor, workspace) => addRssRule(
    actor, workspace,
    z.string().trim().min(1).max(80).parse(form.get('name')),
    z.string().trim().max(2048).parse(form.get('url')),
    form.get('publishAfterApproval') === 'yes' || form.get('aiTopic')
      ? z.array(z.uuid()).max(20).parse(form.getAll('channel')) : [],
    z.string().trim().max(300).parse(form.get('aiTopic') ?? '')
      ? {
        topic: z.string().trim().max(300).parse(form.get('aiTopic')),
        instructions: z.string().trim().max(1500).parse(form.get('aiInstructions') ?? ''),
        image: form.get('aiImage') === 'yes',
        autoSchedule: form.get('publishAfterApproval') === 'yes',
      } : undefined,
  ));
}

export async function toggleFeedAction(form: FormData) {
  await perform(form, 'saved', (actor, workspace) => setRssEnabled(
    actor, workspace, z.uuid().parse(form.get('id')), z.enum(['yes', 'no']).parse(form.get('enabled')) === 'yes',
  ));
}

export async function runFeedAction(form: FormData) {
  await perform(form, 'queued', (actor, workspace) => queueRssRun(actor, workspace, z.uuid().parse(form.get('id'))));
}
