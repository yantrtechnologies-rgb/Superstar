import { GST_RATE, planCatalog, planFeatures, planIds, withGst } from '@cadencedesk/data';
import Link from 'next/link';

export const metadata = { title: 'Pricing · Superstar' };

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const gstPercent = Math.round(GST_RATE * 100);

const faqs: [string, string][] = [
  ['Is GST included?', `No. Prices are shown before GST, and ${gstPercent}% GST is added at checkout. For example, Creator is ${inr.format(1000)} + GST = ${inr.format(withGst(1000))} a month.`],
  ['How do I pay?', 'Plans are billed monthly through Razorpay with a card or a bank e-mandate, and renew automatically each month. AI credit packs are one-time payments and also accept net banking.'],
  ['Can I change or cancel my plan?', 'Yes. Cancel any time from the Billing page and you keep your plan until the end of the month you paid for. To change plans, cancel and subscribe to the new plan, or contact us and we will switch it for you.'],
  ['What counts as a channel?', 'Each connected account is one channel: a Facebook Page, an Instagram account, a LinkedIn profile or page, a YouTube channel, an X account or a Telegram channel.'],
  ['What happens if I go over my plan?', 'You cannot connect more channels or invite more people than your plan allows. If you move to a smaller plan while you have more channels connected, scheduling is paused until you disconnect the extra channels or upgrade. Nothing is deleted.'],
  ['Do I need my own developer accounts?', 'No. You sign in to each network with your own account and Superstar handles the rest.'],
];

export default function PricingPage() {
  return (
    <main className="public-home pricing-page">
      <nav className="public-nav" aria-label="Main navigation">
        <Link className="wordmark" href="/">Superstar</Link>
        <Link href="/login" className="primary">Sign in</Link>
      </nav>
      <header className="pricing-hero">
        <h1>Simple plans for every team</h1>
        <p>Schedule posts to Facebook, Instagram, LinkedIn, YouTube, X and Telegram from one calendar. Start free, upgrade when you need more channels.</p>
      </header>
      <div className="pricing-grid">
        {planIds.map((id) => {
          const plan = planCatalog[id];
          return (
            <section key={id} className={'pricing-card' + (id === 'team' ? ' featured' : '')} aria-labelledby={`plan-${id}`}>
              {id === 'team' && <span className="pricing-badge">Most popular</span>}
              <h2 id={`plan-${id}`}>{plan.name}</h2>
              <p className="pricing-tagline">{plan.tagline}</p>
              <p className="pricing-price">
                <strong>{plan.monthlyInr ? inr.format(plan.monthlyInr) : '₹0'}</strong>
                <span>{plan.monthlyInr ? ' / month + GST' : ' forever'}</span>
              </p>
              <p className="pricing-gst">{plan.monthlyInr ? `${inr.format(withGst(plan.monthlyInr))} a month including ${gstPercent}% GST` : 'No card needed'}</p>
              <ul className="pricing-limits">
                <li><strong>{plan.channels}</strong> {plan.channels === 1 ? 'channel' : 'channels'}</li>
                <li><strong>{plan.seats}</strong> {plan.seats === 1 ? 'user' : 'team members'}</li>
              </ul>
              <ul className="pricing-features">
                {planFeatures[id].map((feature) => <li key={feature}>{feature}</li>)}
              </ul>
              <Link href={id === 'free' ? '/signup' : `/pricing/choose?plan=${id}`} prefetch={false} className={'pricing-cta' + (id === 'team' ? ' primary' : '')}>
                {id === 'free' ? 'Start free' : `Choose ${plan.name}`}
              </Link>
            </section>
          );
        })}
      </div>
      <section className="pricing-faq">
        <h2>Frequently asked questions</h2>
        {faqs.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </section>
    </main>
  );
}
