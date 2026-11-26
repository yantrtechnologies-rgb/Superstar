'use server';

import { PlanLimitError, ProviderConfigurationError, saveConnectLinkMetaAccounts, startConnectLink, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The client agreed on the link page: send them to the network's sign-in. */
export async function startConnectLinkAction(form: FormData) {
  const token = secret.safeParse(form.get('token'));
  if (!token.success) redirect('/connect/done?status=invalid');
  let destination: string;
  try {
    destination = await startConnectLink(token.data);
  } catch (error) {
    if (error instanceof PlanLimitError) redirect('/connect/done?status=plan-limit');
    if (error instanceof ProviderConfigurationError) redirect(`/connect/${token.data}?status=busy`);
    if (error instanceof WorkspaceAccessError) redirect('/connect/done?status=invalid');
    throw error;
  }
  redirect(destination);
}

/** The client picked Facebook Pages / Instagram accounts after signing in through a link. */
export async function saveConnectLinkSelectionAction(form: FormData) {
  const selection = secret.safeParse(form.get('selection'));
  if (!selection.success) redirect('/connect/done?status=invalid');
  const accounts = form.getAll('account').filter((value): value is string => typeof value === 'string');
  if (!accounts.length) redirect(`/connect/select?selection=${selection.data}&status=none`);
  let status = 'saved';
  try {
    await saveConnectLinkMetaAccounts(selection.data, accounts);
  } catch (error) {
    if (error instanceof PlanLimitError) status = 'plan-limit';
    else if (error instanceof WorkspaceAccessError || error instanceof z.ZodError) status = 'invalid';
    else throw error;
  }
  redirect('/connect/done?status=' + status);
}
