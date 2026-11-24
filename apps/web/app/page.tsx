import Link from 'next/link';

const connect = '/app?intent=channels';

const providers = [
  ['facebook', 'f', 'Facebook'], ['instagram', 'ig', 'Instagram'], ['linkedin', 'in', 'LinkedIn'], ['youtube', '▶', 'YouTube'],
  ['x', 'X', 'X'], ['telegram', 'tg', 'Telegram'], ['discord', 'dc', 'Discord'],
] as const;

const week = [
  ['Mon 16', [['9:00', 'Campaign teaser', 'ok'], ['14:30', 'Behind the scenes', '']]],
  ['Tue 17', [['11:00', 'Customer story', 'warn']]],
  ['Wed 18', [['10:15', 'Product launch thread', ''], ['18:00', 'Launch recap', '']]],
  ['Thu 19', [['12:00', 'Team spotlight', 'ok']]],
  ['Fri 20', [['16:45', 'Weekend giveaway', '']]],
] as const;

const icon = (path: string) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
);

export default function Home() {
  return (
    <div className="landing">
      <div className="landing-glow" aria-hidden="true" />
      <main className="public-home">
        <nav className="public-nav" aria-label="Main navigation">
          <Link href="/" className="wordmark">Superstar</Link>
          <div>
            <a className="hide-sm" href="#features">Features</a>
            <a className="hide-sm" href="#channels">Channels</a>
            <Link href="/pricing">View plans</Link>
            <Link href="/login" className="btn btn-outline btn-pill">Sign in</Link>
          </div>
        </nav>

        <section className="landing-hero">
          <span className="eyebrow"><b>New</b> AI Studio drafts posts and visuals for you</span>
          <h1>Plan, approve and publish <span className="gradient-text">every social post</span> from one calendar</h1>
          <p>Superstar brings your channels, your team and your clients into one workspace. Draft with AI, collect approvals, then schedule to every network at once.</p>
          <div className="landing-actions">
            <Link href={connect} className="btn btn-light btn-pill">Connect your channels →</Link>
            <a href="#features" className="btn btn-outline btn-pill">See how it works</a>
          </div>
          <ul className="provider-strip" aria-label="Supported networks" id="channels">
            {providers.map(([id, mark, name]) => <li key={id} data-provider={id} title={name}><span aria-hidden="true">{mark}</span><span className="sr-only">{name}</span></li>)}
          </ul>
        </section>

        <figure className="app-preview" aria-label="Superstar calendar preview">
          <div className="app-preview-window">
            <div className="app-preview-side" aria-hidden="true">
              <span className="wordmark">Superstar</span>
              <span>Overview</span><span className="on">Calendar</span><span>Posts</span><span>Channels</span><span>Analytics</span><span>AI Studio</span>
            </div>
            <div className="app-preview-main">
              <div className="app-preview-top"><span>Nov 16 – 20, 2026</span><i>+ Create post</i></div>
              <ol className="app-preview-grid" aria-label="Sample campaign agenda">
                {week.map(([day, items]) => (
                  <li key={day}>
                    <h4>{day}</h4>
                    {items.map(([time, title, tone]) => <p key={title} className={tone}><b>{time}</b><br />{title}</p>)}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </figure>

        <section className="landing-section" aria-labelledby="audience-title">
          <h2 id="audience-title">Built for the people behind the posts</h2>
          <p className="section-lead">Whether you run one brand or forty, Superstar keeps the plan, the approvals and the results in one place.</p>
          <div className="audience-grid">
            <article>
              <div className="icon-bubble">{icon('M12 3l2.5 5.5L20 9.5l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1z')}</div>
              <h3>Creators</h3>
              <p>Batch a week of content in an afternoon and let the calendar post it at the right time.</p>
            </article>
            <article>
              <div className="icon-bubble">{icon('M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.3M15.5 3.7a3.5 3.5 0 0 1 0 6.6')}</div>
              <h3>Marketing teams</h3>
              <p>Draft together, review with roles and permissions, and keep one shared view of what ships when.</p>
            </article>
            <article>
              <div className="icon-bubble">{icon('M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6')}</div>
              <h3>Agencies</h3>
              <p>Group channels by client, send review links for sign-off, and report on every account.</p>
            </article>
          </div>
        </section>

        <section className="landing-section" id="features" aria-labelledby="features-title">
          <h2 id="features-title">From first draft to published post</h2>
          <p className="section-lead">Everything you need to run social, without juggling five tools.</p>
          <div className="feature-grid">
            <article className="feature-card tone-a">
              <small>Plan</small>
              <h3>A calendar your whole team can read at a glance</h3>
              <p>Week and month views, client groups and shared posting slots keep every channel on schedule.</p>
            </article>
            <article className="feature-card tone-b">
              <small>Create</small>
              <h3>AI Studio for copy and visuals</h3>
              <p>Generate captions, rewrite for each network and create images without leaving your workspace.</p>
            </article>
            <article className="feature-card">
              <small>Review</small>
              <h3>Client approval on the exact revision</h3>
              <ul><li>Shareable review links</li><li>Comments on every draft</li><li>Approvals tracked per revision</li></ul>
            </article>
            <article className="feature-card">
              <small>Publish and automate</small>
              <h3>Schedule everywhere, then connect your stack</h3>
              <ul><li>Per-channel delivery status</li><li>REST API, SDK, CLI and MCP</li><li>Webhooks and RSS automations</li></ul>
            </article>
          </div>
        </section>

        <section className="cta-band" aria-labelledby="cta-title">
          <h2 id="cta-title">Your next month of content starts here</h2>
          <p>Create a workspace, connect a channel and schedule your first post in minutes.</p>
          <div className="landing-actions">
            <Link href={connect} className="btn btn-light btn-pill">Get started free</Link>
            <Link href="/pricing" className="btn btn-outline btn-pill">Compare plans</Link>
          </div>
        </section>

        <footer className="public-footer">
          <Link href="/" className="wordmark">Superstar</Link>
          <nav aria-label="Footer">
            <Link href="/pricing">Pricing</Link><Link href={connect}>Connect channels</Link>
            <Link href="/legal/privacy">Privacy</Link><Link href="/legal/terms">Terms</Link><Link href="/legal/data-deletion">Data deletion</Link>
          </nav>
        </footer>
      </main>
    </div>
  );
}
