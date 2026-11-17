'use server';

import { keyInput, workspaceSlug } from '@cadencedesk/contracts';
import { createApiKey, revokeApiKey, WorkspaceAccessError } from '@cadencedesk/data';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../../lib/require-user';

type KeyResult = { token: string; message: string };

export async function createKeyAction(_previous: KeyResult, form: FormData): Promise<KeyResult> {
  const user = await requireUser();
  const workspace = workspaceSlug.safeParse(form.get('workspace'));
  const input = keyInput.safeParse({ name: form.get('name'), days: form.get('days'), scopes: form.getAll('scope') });
  if (!workspace.success || !input.success) {
    return { token: '', message: 'Enter a key name, expiration and at least one scope.' };
  }
  try {
    const token = await createApiKey(user.id, workspace.data, input.data.name, input.data.days, input.data.scopes);
    revalidatePath(`/app/${workspace.data}/settings/api-keys`);
    return { token, message: 'API key created.' };
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    return { token: '', message: error.message };
  }
}

export async function revokeKeyAction(form: FormData) {
  const user = await requireUser();
  const input = z.object({ workspace: workspaceSlug, id: z.uuid() }).safeParse(Object.fromEntries(form));
  if (!input.success) redirect('/app');
  const { workspace, id } = input.data;
  const path = `/app/${workspace}/settings/api-keys`;
  try {
    await revokeApiKey(user.id, workspace, id);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    redirect(path + '?status=unavailable');
  }
  redirect(path + '?status=revoked');
}
