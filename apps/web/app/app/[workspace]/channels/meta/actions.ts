'use server';

import { beginMetaConnection, disconnectMetaAccount, metaProvider, ProviderConfigurationError, saveMetaAccounts, WorkspaceAccessError } from '@cadencedesk/data';
import { workspaceSlug } from '@cadencedesk/contracts';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../../lib/require-user';

export async function metaConnectionAction(form: FormData) {
  const user = await requireUser();
  const workspace = workspaceSlug.safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  const base = '/app/' + workspace.data + '/channels';
  let destination = base + '?status=saved';
  try {
    const intent = z.enum(['connect', 'save', 'disconnect']).parse(form.get('intent'));
    if (intent === 'connect') {
      destination = await beginMetaConnection(user.id, workspace.data, metaProvider.parse(form.get('provider')));
    } else if (intent === 'save') {
      await saveMetaAccounts(user.id, workspace.data, z.string().parse(form.get('selection')), z.array(z.string()).parse(form.getAll('account')));
    } else {
      await disconnectMetaAccount(user.id, workspace.data, z.uuid().parse(form.get('channelId')));
      destination = base + '?status=meta-disconnected';
    }
  } catch (error) {
    if (!(error instanceof ProviderConfigurationError || error instanceof WorkspaceAccessError || error instanceof z.ZodError)) throw error;
    destination = base + '?status=meta-unavailable';
  }
  redirect(destination);
}
