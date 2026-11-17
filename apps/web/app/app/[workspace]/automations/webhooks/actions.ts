'use server';

import { addWebhook, rotateWebhookSecret, setWebhookEnabled, WebhookConfigurationError, WorkspaceAccessError } from '@cadencedesk/data';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../../lib/require-user';

const slug = z.string().regex(/^[a-z0-9-]{1,64}$/);
type SecretResult = { secret: string; message: string };

export async function saveWebhookSecretAction(_previous: SecretResult, form: FormData): Promise<SecretResult> {
  const actor = await requireUser();
  const workspace = slug.safeParse(form.get('workspace'));
  const result = { secret: '', message: 'Check the subscription details and your workspace access.' };
  if (!workspace.success) return result;
  const scope = workspace.data;
  try {
    const id = form.get('id');
    if (id) {
      const secret = await rotateWebhookSecret(actor.id, scope, z.uuid().parse(id));
      revalidatePath(`/app/${scope}/automations/webhooks`);
      return { secret, message: 'Signing secret rotated.' };
    }
    const created = await addWebhook(
      actor.id, scope, z.string().trim().min(1).max(80).parse(form.get('name')),
      z.string().trim().max(2048).parse(form.get('endpoint')),
    );
    revalidatePath(`/app/${scope}/automations/webhooks`);
    return { secret: created.secret, message: 'Webhook subscription created.' };
  } catch (error) {
    if (error instanceof WebhookConfigurationError) return { secret: '', message: error.message };
    if (error instanceof z.ZodError || error instanceof WorkspaceAccessError) return result;
    throw error;
  }
}

export async function toggleWebhookAction(form: FormData) {
  const actor = await requireUser();
  const fields = z.object({ workspace: slug, id: z.uuid(), enabled: z.enum(['yes', 'no']) }).safeParse(Object.fromEntries(form));
  if (!fields.success) redirect('/app');
  const { workspace, id, enabled } = fields.data;
  const path = `/app/${workspace}/automations/webhooks`;
  try {
    await setWebhookEnabled(actor.id, workspace, id, enabled === 'yes');
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    redirect(path + '?status=invalid');
  }
  redirect(path + (enabled === 'yes' ? '?status=enabled' : '?status=paused'));
}
