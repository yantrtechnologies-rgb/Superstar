import Link from 'next/link';
import { billingCatalog, limitRows } from '../../lib/billing-catalog';

export const dynamic = 'force-dynamic';

export default function PricingPage() {
  const catalog = billingCatalog();
  return (
    <main className="public-home pb-12">
      <nav className="public-nav" aria-label="Main navigation">
        <Link className="wordmark" href="/">CadenceDesk AI</Link>
        <Link href="/login" className="primary">Sign in</Link>
      </nav>
      <header className="my-12 max-w-xl">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">Plans and pricing</h1>
        <p className="mt-4 text-lg">Compare plans for your social campaign workspace. Paid plans will have monthly and annual options.</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {catalog.map((plan) => (
          <section key={plan.id} className="pricing-card rounded-xl border bg-white p-5">
            <h2 className="text-xl font-semibold">{plan.name}</h2>
            <p className="mt-2 font-semibold text-emerald-900">{plan.id === 'free' ? 'Free' : 'Pricing pending'}</p>
            <p className="my-4 min-h-12">{plan.audience}</p>
            <dl className="divide-y divide-stone-200 border-t border-stone-200">
              {limitRows.map(([key, label]) => (
                <div key={key} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <dt>{label}</dt>
                  <dd className="shrink-0 tabular-nums">{plan.limits[key]?.toLocaleString('en-US') ?? 'TBD'}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <section className="mt-10 max-w-2xl">
        <h2 className="mb-4 text-2xl font-semibold">Frequently asked questions</h2>
        <details className="border-t border-stone-300 py-4">
          <summary className="cursor-pointer font-semibold">How do I start a workspace?</summary>
          <p className="mt-2">Sign in with a magic link and create a workspace from your workspace directory.</p>
        </details>
        <details className="border-y border-stone-300 py-4">
          <summary className="cursor-pointer font-semibold">Can I buy a subscription now?</summary>
          <p className="mt-2">Paid subscriptions will be available after pricing and checkout are configured.</p>
        </details>
      </section>
    </main>
  );
}
