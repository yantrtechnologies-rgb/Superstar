import { findMembership, prisma } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { billingCatalog } from '../../../../lib/billing-catalog';
import { requireUser } from '../../../../lib/require-user';
import { stripeBilling, stripePrices } from '../../../../lib/stripe-billing';
import { openBillingAction } from './actions';

const number = new Intl.NumberFormat('en-US');

export default async function BillingPage({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const { workspace } = await params;
  const member = await findMembership(user.id, workspace);
  if (!member || (member.role !== 'OWNER' && member.role !== 'ADMIN')) notFound();
  const workspaceId = member.workspace.id;
  const { status } = await searchParams;
  const catalog = billingCatalog();
  const billingEnabled = stripeBilling() !== null;
  const prices = billingEnabled ? stripePrices() : [];
  const account = billingEnabled ? await prisma.billingAccount.findUnique({ where: { workspaceId } }) : null;
  const activePrice = prices.find(({ price }) => price === account?.priceId);
  const planId = account?.status === 'active' || account?.status === 'trialing' ? activePrice?.plan : 'free';
  const limits = catalog.find(({ id }) => id === planId)?.limits;
  const [seats, channels, scheduled, feeds, webhooks, credits] = await Promise.all([
    prisma.membership.count({ where: { workspaceId } }),
    prisma.channel.count({ where: { workspaceId } }),
    prisma.destination.count({ where: { post: { workspaceId }, state: 'SCHEDULED' } }),
    prisma.rssRule.count({ where: { workspaceId } }),
    prisma.webhookSubscription.count({ where: { workspaceId } }),
    prisma.creditAccount.findUnique({
      where: { workspaceId },
      select: { available: true, entries: { take: 20, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] } },
    }),
  ]);

  const usage = [
    ['Connected channels', channels, limits?.channels],
    ['Workspace seats', seats, limits?.seats],
    ['Scheduled destinations', scheduled, limits?.scheduledDestinations],
    ['Automation rules', feeds + webhooks, limits?.automationRules],
  ] as const;
  return (
    <>
      <h1>Usage and billing</h1>
      <p>Track workspace usage and AI credits.</p>
      <section className="my-6 rounded-xl border border-stone-300 bg-white p-5">
        <h2>Workspace usage</h2>
        <dl className="divide-y divide-stone-200">
          {usage.map(([label, used, limit]) => (
            <div key={label} className="flex justify-between gap-3 py-3">
              <dt>{label}</dt>
              <dd className="tabular-nums">{number.format(used)}{limit !== undefined && <> · {number.format(limit)} planned limit</>}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="my-6 rounded-xl border border-stone-300 bg-white p-5">
        <h2>AI credit history</h2>
        <p>{number.format(credits?.available ?? 0)} credits available</p>
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
        ) : <p className="mt-3">Credit activity will appear here after your first ledger entry.</p>}
      </section>
      <section className="my-6 rounded-xl border border-stone-300 bg-white p-5">
        <h2>Subscriptions</h2>
                {status === 'checkout' && <p role="status">Checkout returned. Subscription status updates after Stripe confirmation.</p>}
        {status === 'unavailable' && <p role="status">Billing is unavailable for this request. Check your subscription or try again.</p>}
        {account?.status && <p className="mb-2">{activePrice?.plan ?? 'Subscription'} · {account.status.replaceAll('_', ' ')}</p>}
        {account?.periodEnd && <p className="mb-2">{account.cancelAtPeriodEnd ? 'Ends' : 'Current period ends'} on {account.periodEnd.toISOString().slice(0, 10)}</p>}
        {account && (
          <form action={openBillingAction} className="my-3">
            <input type="hidden" name="workspace" value={workspace} />
            <button name="intent" value="portal">Manage subscription and invoices</button>
          </form>
        )}
        {!account?.stripeSubscriptionId && prices.map(({ plan, period }) => (
          <form key={plan + period} action={openBillingAction} className="my-3">
            <input type="hidden" name="workspace" value={workspace} />
            <input type="hidden" name="plan" value={plan} />
            <input type="hidden" name="period" value={period} />
            <button type="submit">Open Stripe test Checkout for {catalog.find(({ id }) => id === plan)?.name} ({period})</button>
          </form>
        ))}
        {!prices.length && !account && <p className="mb-3">Paid subscriptions are pending billing configuration.</p>}
        <Link href="/pricing">Compare plans</Link>
      </section>
    </>
  );
}
