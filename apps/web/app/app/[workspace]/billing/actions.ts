'use server';

import { workspaceSlug } from '@cadencedesk/contracts';
import {
  attachCreditPaymentLink, canManageTeam, creditPackIds, creditPacks, findMembership, prisma, startCreditPurchase, withGst,
  type CreditPackId,
} from '@cadencedesk/data';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { chosenPlanCookie } from '../../../../lib/chosen-plan';
import { requireUser } from '../../../../lib/require-user';
import { cancelRazorpaySubscription, createCreditPaymentLink, createRazorpayCheckout, razorpayBilling } from '../../../../lib/razorpay-billing';
import { createSubscriptionCheckout, interval, paidPlan, stripeBilling } from '../../../../lib/stripe-billing';

export async function razorpayBillingAction(form: FormData) {
  const user = await requireUser();
  const slug = workspaceSlug.safeParse(form.get('workspace'));
  if (!slug.success) redirect('/app');
  const path = '/app/' + slug.data + '/billing';
  const billing = razorpayBilling();
  const member = await findMembership(user.id, slug.data);
  if (!member || !canManageTeam(member.role)) redirect('/app');
  if (!billing) redirect(path + '?status=unavailable');
  let url: string | null = null;
  try {
    if (form.get('intent') === 'cancel') {
      const cancelled = await cancelRazorpaySubscription(billing, user.id, member.workspace.id);
      url = path + (cancelled ? '?status=cancel-scheduled' : '?status=unavailable');
    } else {
      const plan = paidPlan.safeParse(form.get('plan'));
      const period = interval.safeParse(form.get('period'));
      if (plan.success && period.success) {
        url = await createRazorpayCheckout(billing, user.id, member.workspace.id, plan.data, period.data);
        if (url) (await cookies()).delete(chosenPlanCookie);
      }
    }
  } catch {
    redirect(path + '?status=unavailable');
  }
  redirect(url ?? path + '?status=unavailable');
}

export async function buyCreditsAction(form: FormData) {
  const user = await requireUser();
  const slug = workspaceSlug.safeParse(form.get('workspace'));
  if (!slug.success) redirect('/app');
  const path = '/app/' + slug.data + '/billing';
  const billing = razorpayBilling();
  const pack = z.enum(creditPackIds as [CreditPackId, ...CreditPackId[]]).safeParse(form.get('pack'));
  if (!billing || !pack.success) redirect(path + '?status=unavailable');
  let url: string | null = null;
  try {
    const amountPaise = withGst(creditPacks[pack.data].priceInr) * 100;
    const purchase = await startCreditPurchase(user.id, slug.data, pack.data, amountPaise);
    const link = await createCreditPaymentLink(billing, purchase);
    await attachCreditPaymentLink(purchase.id, link.id, link.url);
    url = link.url;
  } catch {
    redirect(path + '?status=unavailable');
  }
  redirect(url ?? path + '?status=unavailable');
}

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
