import { findMembership, prisma } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { billingCatalog } from '../../../../lib/billing-catalog';
import { requireUser } from '../../../../lib/require-user';

const number = new Intl.NumberFormat('en-US');

export default async function BillingPage({ params }: { params: Promise<{ workspace: string }> }) {
  const user = await requireUser();
  const { workspace } = await params;
  const member = await findMembership(user.id, workspace);
  if (!member || (member.role !== 'OWNER' && member.role !== 'ADMIN')) notFound();
  const workspaceId = member.workspace.id;
  const limits = billingCatalog().find(({ id }) => id === 'free')?.limits;
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
        <p className="mb-3">Paid subscriptions are pending billing configuration.</p>
        <Link href="/pricing">Compare plans</Link>
      </section>
    </>
  );
}
