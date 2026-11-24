import {
  aiQuote, billingEnforced, creditPackIds, creditPacks, GST_RATE, planCatalog, planIds, prisma, withGst, workspacePlan, type PlanId,
} from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { isRazorpayPaid, razorpayBilling, razorpayPlans } from '../../../../lib/razorpay-billing';
import { stripeBilling } from '../../../../lib/stripe-billing';
import { buyCreditsAction, openBillingAction, razorpayBillingAction } from './actions';

const number = new Intl.NumberFormat('en-IN');
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const liveStates = ['authenticated', 'active', 'pending', 'halted', 'paused'];

const statusMessages: Record<string, string> = {
  checkout: 'Payment page opened. Your plan updates here as soon as Razorpay confirms the payment, usually within a minute.',
  unavailable: 'Billing is unavailable for this request. Check your subscription or try again.',
  'cancel-scheduled': 'Cancellation scheduled. You keep your plan until the end of the current billing month.',
  'credits-added': 'Payment received. Your AI credits have been added.',
  'credits-pending': 'Payment is being confirmed. Your credits appear here within a minute; refresh to check.',
  'credits-canceled': 'The credit payment was not completed, so nothing was charged.',
};

export default async function BillingPage({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; plan?: string }>;
}) {
  const user = await requireUser();
  const { workspace } = await params;
  const member = await getMembership(user.id, workspace);
  if (!member || (member.role !== 'OWNER' && member.role !== 'ADMIN')) notFound();
  const workspaceId = member.workspace.id;
  const { status, plan: requestedPlan } = await searchParams;

  const razorpay = razorpayBilling();
  const razorpayCatalog = razorpay ? razorpayPlans().filter((p) => p.period === 'monthly') : [];
  const [plan, razorpaySub, stripeAccount, seats, invites, channels, credits] = await Promise.all([
    workspacePlan(prisma, workspaceId),
    prisma.razorpaySubscription.findUnique({ where: { workspaceId } }),
    stripeBilling() ? prisma.billingAccount.findUnique({ where: { workspaceId } }) : null,
    prisma.membership.count({ where: { workspaceId } }),
    prisma.invitation.count({ where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.channel.count({ where: { workspaceId } }),
    prisma.creditAccount.findUnique({
      where: { workspaceId },
      select: { available: true, entries: { take: 20, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] } },
    }),
  ]);
  const current: PlanId | null = plan?.id ?? null;
  const limits = current ? planCatalog[current] : null;
  const subscribed = razorpaySub && liveStates.includes(razorpaySub.status);
  const gstPercent = Math.round(GST_RATE * 100);
  const wanted = requestedPlan === 'creator' || requestedPlan === 'team' || requestedPlan === 'agency' ? requestedPlan : null;
  const wantedOffer = wanted && !subscribed ? razorpayCatalog.find((entry) => entry.plan === wanted) : null;

  return (
    <>
      <h1>Plan and billing</h1>
      {status && statusMessages[status] && <p role="status">{statusMessages[status]}</p>}
      {wanted && wantedOffer && (
        <section className="plan-upgrade-banner">
          <strong>Complete your {planCatalog[wanted].name} subscription</strong>
          <p>
            {inr.format(planCatalog[wanted].monthlyInr)} a month + {gstPercent}% GST = <strong>{inr.format(withGst(planCatalog[wanted].monthlyInr))}</strong> a month,
            {' '}{planCatalog[wanted].channels} channels and {planCatalog[wanted].seats === 1 ? '1 user' : `${planCatalog[wanted].seats} team members`}.
            You pay securely on Razorpay and come back here when it is done.
          </p>
          <form action={razorpayBillingAction}>
            <input type="hidden" name="workspace" value={workspace} />
            <input type="hidden" name="plan" value={wanted} />
            <input type="hidden" name="period" value="monthly" />
            <button type="submit" className="primary">Pay {inr.format(withGst(planCatalog[wanted].monthlyInr))} and start {planCatalog[wanted].name}</button>
          </form>
        </section>
      )}
      {wanted && subscribed && <p role="status">This workspace already has an active subscription. Cancel it first to switch plans.</p>}

      <section className="my-6 rounded-xl border border-stone-300 bg-white p-5">
        <h2>{current ? `${planCatalog[current].name} plan` : billingEnforced() ? 'Unlimited (exempt workspace)' : 'No plan limits'}</h2>
        <p className="muted-line">
          {current === 'free' && 'You are on the Free plan. Upgrade to connect more channels and invite your team.'}
          {current && current !== 'free' && razorpaySub?.currentEnd && (razorpaySub.cancelAtCycleEnd
            ? `Cancelled. Your plan stays active until ${razorpaySub.currentEnd.toISOString().slice(0, 10)}, then moves to Free.`
            : `Renews on ${razorpaySub.currentEnd.toISOString().slice(0, 10)} for ${inr.format(withGst(planCatalog[current].monthlyInr))} including GST.`)}
          {!current && !billingEnforced() && 'Billing is switched off on this installation, so no plan limits apply.'}
        </p>
        <dl className="plan-usage">
          <div>
            <dt>Channels</dt>
            <dd className={limits && channels > limits.channels ? 'over' : ''}>{number.format(channels)}{limits && <> / {limits.channels}</>}</dd>
          </div>
          <div>
            <dt>Team members{invites ? ' (incl. pending invites)' : ''}</dt>
            <dd className={limits && seats + invites > limits.seats ? 'over' : ''}>{number.format(seats + invites)}{limits && <> / {limits.seats}</>}</dd>
          </div>
        </dl>
        {limits && channels > limits.channels && (
          <p role="status" className="mt-3">This workspace has more channels than its plan allows, so scheduling is paused. Upgrade or disconnect {channels - limits.channels} channel{channels - limits.channels === 1 ? '' : 's'}.</p>
        )}
      </section>

      <section className="my-6 rounded-xl border border-stone-300 bg-white p-5">
        <h2>Plans</h2>
        <p className="muted-line">Billed monthly through Razorpay with a card or bank e-mandate, renewing automatically. Prices exclude {gstPercent}% GST.{razorpay && !razorpay.live ? ' Razorpay is in test mode: no real money is charged.' : ''}</p>
        <div className="plan-choices">
          {planIds.filter((id) => id !== 'free').map((id) => {
            const p = planCatalog[id];
            const offer = razorpayCatalog.find((entry) => entry.plan === id);
            return (
              <div key={id} className={'plan-choice' + (current === id ? ' current' : '')}>
                <strong>{p.name}{current === id ? ' · current plan' : ''}</strong>
                <span>{inr.format(p.monthlyInr)} / month + GST</span>
                <span className="muted-line">{p.channels} channels · {p.seats === 1 ? '1 user' : `${p.seats} team members`}</span>
                {!subscribed && offer && (
                  <form action={razorpayBillingAction}>
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="plan" value={id} />
                    <input type="hidden" name="period" value="monthly" />
                    <button type="submit" className="primary">Subscribe for {inr.format(withGst(p.monthlyInr))}/mo</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        {subscribed && isRazorpayPaid(razorpaySub.status) && !razorpaySub.cancelAtCycleEnd && (
          <form action={razorpayBillingAction} className="mt-4">
            <input type="hidden" name="workspace" value={workspace} />
            <p className="muted-line">To change plans, cancel here and subscribe to the new plan once this one ends, or contact support to switch now.</p>
            <button name="intent" value="cancel">Cancel at end of billing month</button>
          </form>
        )}
        {razorpaySub?.status === 'created' && razorpaySub.shortUrl && (
          <p className="mt-4"><a href={razorpaySub.shortUrl}>Finish your pending payment</a></p>
        )}
        {!razorpay && <p className="mt-4">Online payment is not switched on yet.</p>}
        {razorpay && !razorpayCatalog.length && <p className="mt-4">Plans are not set up in Razorpay yet.</p>}
        {stripeAccount && (
          <form action={openBillingAction} className="mt-4">
            <input type="hidden" name="workspace" value={workspace} />
            <button name="intent" value="portal">Manage Stripe subscription and invoices</button>
          </form>
        )}
        <p className="mt-4"><Link href="/pricing">Compare all plan features</Link></p>
      </section>

      <section className="my-6 rounded-xl border border-stone-300 bg-white p-5">
        <h2>AI credits</h2>
        <p><strong>{number.format(credits?.available ?? 0)}</strong> credits available. Credits are used in AI Studio and never expire.</p>
        <p className="muted-line">
          Costs: social copy {aiQuote('TEXT')?.credits ?? '–'} · image {aiQuote('IMAGE')?.credits ?? '–'} · video {aiQuote('VIDEO')?.credits ?? '–'} credits.
          Failed generations are refunded automatically.
        </p>
        <div className="plan-choices">
          {creditPackIds.map((id) => {
            const pack = creditPacks[id];
            return (
              <div key={id} className="plan-choice">
                <strong>{pack.name} · {number.format(pack.credits)} credits</strong>
                <span>{inr.format(pack.priceInr)} + GST</span>
                <span className="muted-line">{inr.format(withGst(pack.priceInr))} including GST</span>
                {razorpay && (
                  <form action={buyCreditsAction}>
                    <input type="hidden" name="workspace" value={workspace} />
                    <input type="hidden" name="pack" value={id} />
                    <button type="submit" className="primary">Buy {number.format(pack.credits)} credits</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        {!razorpay && <p className="mt-3">Buying credits will be available once online payment is switched on.</p>}
        <h3 className="mt-6">Credit history</h3>
        {credits?.entries.length ? (
          <ul className="mt-4 divide-y divide-stone-200">
            {credits.entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="capitalize">{entry.kind.toLowerCase().replaceAll('_', ' ')}</span>
                <time dateTime={entry.createdAt.toISOString()}>{entry.createdAt.toISOString().slice(0, 10)}</time>
                <span className="tabular-nums">{entry.delta > 0 ? '+' : ''}{number.format(entry.delta)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3">Credit activity will appear here after your first AI job.</p>}
      </section>
    </>
  );
}
