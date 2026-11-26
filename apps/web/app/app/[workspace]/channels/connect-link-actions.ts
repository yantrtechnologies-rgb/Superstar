'use server';

import { connectLinkProvider, createConnectLink, ProviderConfigurationError, revokeConnectLink, WorkspaceAccessError } from '@cadencedesk/data';
import { workspaceSlug } from '@cadencedesk/contracts';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

export async function connectLinkAction(form: FormData) {
  const user = await requireUser();
  const workspace = workspaceSlug.safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  const base = `/app/${workspace.data}/channels`;
  let status = 'link-created';
  try {
    if (z.enum(['create', 'revoke']).parse(form.get('intent')) === 'create') {
      const label = form.get('label');
      await createConnectLink(user.id, workspace.data, connectLinkProvider.parse(form.get('provider')),
        typeof label === 'string' ? label : undefined);
    } else {
      await revokeConnectLink(user.id, workspace.data, z.string().parse(form.get('link')));
      status = 'link-revoked';
    }
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError || error instanceof ProviderConfigurationError || error instanceof z.ZodError)) throw error;
    status = 'link-unavailable';
  }
  redirect(`${base}?status=${status}#client-links`);
}
