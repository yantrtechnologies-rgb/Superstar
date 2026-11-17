'use server';

import { acceptInvitation, createWorkspace, inviteMember, ownerInvitationRoles, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { signOut } from '../../auth';
import { emailConfig } from '../../lib/auth-config';
import { deliverEmail } from '../../lib/mail';
import { requireUser } from '../../lib/require-user';

const workspaceFields = z.object({
  name: z.string().trim().min(1).max(80),
  timeZone: z.string().max(100).refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
});
const invitationFields = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,64}$/),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: z.enum(ownerInvitationRoles),
});

export async function createWorkspaceAction(form: FormData) {
  const user = await requireUser();
  const fields = workspaceFields.safeParse({ name: form.get('name'), timeZone: form.get('timeZone') });
  const connecting = form.get('intent') === 'channels';
  if (!fields.success) redirect(connecting ? '/app?status=invalid-workspace&intent=channels' : '/app?status=invalid-workspace');
  const workspace = await createWorkspace(user.id, fields.data.name, fields.data.timeZone);
  redirect(`/app/${workspace.slug}${connecting ? '/channels' : ''}`);
}

export async function inviteMemberAction(form: FormData) {
  const user = await requireUser();
  const fields = invitationFields.safeParse({ slug: form.get('slug'), email: form.get('email'), role: form.get('role') });
  if (!fields.success) redirect('/app?status=invalid-invitation');
  const { slug, email, role } = fields.data;
  const settings = `/app/${slug}/settings`;
  const config = emailConfig();
  if (!config) redirect(`${settings}?status=email-unavailable`);
  let workspaceName;
  try {
    workspaceName = await inviteMember(user.id, slug, email, role);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) redirect(`${settings}?status=invitation-unavailable`);
    throw error;
  }
  try {
    await deliverEmail(
      email,
      'Superstar workspace invitation',
      `Join ${workspaceName}`,
      'Sign in with this email address and accept the invitation from your workspace list within seven days.',
      new URL('/app', config.url).href,
      'Open Superstar',
    );
  } catch {
    redirect(`${settings}?status=email-failed`);
  }
  redirect(`${settings}?status=invited`);
}

export async function acceptInvitationAction(form: FormData) {
  const user = await requireUser();
  const invitationId = z.uuid().safeParse(form.get('invitationId'));
  if (!invitationId.success) redirect('/app?status=invalid-invitation');
  let workspace;
  try {
    workspace = await acceptInvitation(user.id, invitationId.data);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) redirect('/app?status=invitation-unavailable');
    throw error;
  }
  redirect(`/app/${workspace.slug}`);
}

export async function logoutAction() {
  await signOut({ redirectTo: '/' });
}
