'use server';

import { workspaceSlug } from '@cadencedesk/contracts';
import { canManageTeam, findMembership, prisma } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { createSubscriptionCheckout, interval, paidPlan, stripeBilling } from '../../../../lib/stripe-billing';

export async function openBillingAction(form: FormData) {
  const user = await requireUser();
  const slug = workspaceSlug.safeParse(form.get('workspace'));
  if (!slug.success) redirect('/app');
  const path = '/app/' + slug.data + '/billing';
  const billing = stripeBilling();
  const member = await findMembership(user.id, slug.data);
  if (!member || !canManageTeam(member.role)) redirect('/app');
  if (!billing) redirect(path + '?status=unavailable');

  let url: string | null = null;
  try {
    if (form.get('intent') === 'portal') {
      const account = await prisma.billingAccount.findUnique({ where: { workspaceId: member.workspace.id } });
      if (account) {
        const session = await billing.stripe.billingPortal.sessions.create({
          customer: account.stripeCustomerId, return_url: billing.origin + path,
        });
        url = session.url;
      }
    } else {
      const plan = paidPlan.safeParse(form.get('plan'));
      const period = interval.safeParse(form.get('period'));
      if (plan.success && period.success) {
        url = await createSubscriptionCheckout(billing, user.id, member.workspace.id, slug.data, plan.data, period.data);
      }
    }
  } catch {
    redirect(path + '?status=unavailable');
  }
  redirect(url ?? path + '?status=unavailable');
}
