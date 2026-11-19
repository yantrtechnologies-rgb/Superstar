import Image from 'next/image';
import Link from 'next/link';

const connect = '/app?intent=channels';

const channels = [
  ['f', 'Facebook', 'Pages you manage'],
  ['◎', 'Instagram', 'Professional accounts'],
  ['in', 'LinkedIn', 'Personal profile'],
  ['➤', 'Telegram', 'Bot and chat'],
  ['◉', 'Discord', 'Bot and server channel'],
  ['#', 'Slack', 'Bot and workspace channel'],
] as const;

const schedule = [
  ['MON', '16', 'Campaign brief', 'Editorial planning', 'paper'],
  ['TUE', '17', 'Behind the scenes', 'Discord · In review', 'warm'],
  ['WED', '18', 'Field notes', 'LinkedIn · Scheduled', 'mint'],
] as const;

export default function Home() {
  return (
    <main className="public-home launch-home">
      <nav className="public-nav" aria-label="Main navigation">
        <Link href="/" className="wordmark">Superstar</Link>
        <div><a className="launch-nav-channels" href="#channels">Channels</a><Link href="/pricing">View plans</Link><Link href="/login" className="primary">Sign in</Link></div>
      </nav>
      <section className="public-hero launch-hero">
        <div>
          <h1>A workspace for <em>social campaigns</em></h1>
          <p>Draft with AI, get client approval, and schedule posts to your connected channels from one workspace.</p>
          <div className="launch-actions">
            <Link href={connect} className="primary">Connect your channels <span aria-hidden="true">↗</span></Link>
            <a href="#workflow">See how it works</a>
          </div>
        </div>
        <div className="launch-visual">
          <Image src="/campaign/studio.webp" alt="A designer arranging a cobalt campaign print in a sunlit studio" width={1200} height={800} preload sizes="(max-width: 760px) 100vw, 50vw" />
          <figure className="agenda-preview launch-agenda">
            <figcaption><span>Fieldwork Studio</span><strong>Campaign agenda</strong></figcaption>
            <ol aria-label="Sample campaign agenda">
              {schedule.map(([day, date, title, detail, tone]) => (
                <li key={date}>
                  <time dateTime={'2026-11-' + date}><small>{day}</small>{date}</time>
                  <div className={'agenda-preview-item ' + tone}><strong>{title}</strong><span>{detail}</span></div>
                </li>
              ))}
            </ol>
          </figure>
        </div>
      </section>
      <section className="launch-channels" id="channels">
        <div className="launch-section-header">
          <div><h2>Bring your channels together</h2><p>Connect Facebook Pages, linked professional Instagram accounts, or a LinkedIn profile. Telegram, Discord, and Slack use configured bots.</p></div>
          <Link href={connect} className="primary">Open channel setup</Link>
        </div>
        <ul>
          {channels.map(([mark, name, detail]) => (
            <li key={name}><span className="launch-channel-mark" aria-hidden="true">{mark}</span><div><strong>{name}</strong><p>{detail}</p></div></li>
          ))}
        </ul>
      </section>
      <section className="launch-workflow" id="workflow">
        <Image src="/campaign/planning.webp" alt="A campaign notebook and colorful print swatches on a sunny desk" width={900} height={506} sizes="(max-width: 760px) 100vw, 50vw" />
        <div>
          <h2>From first draft to published post</h2>
          <dl>
            <div><dt>Plan</dt><dd>Use AI Studio to draft copy and create images, then organize posts in the agenda.</dd></div>
            <div><dt>Review</dt><dd>Share a draft with clients and collect approval on the exact revision.</dd></div>
            <div><dt>Publish</dt><dd>Schedule by channel and check the outcome for each destination.</dd></div>
          </dl>
        </div>
      </section>
      <footer className="public-nav">
        <Link href="/" className="wordmark">Superstar</Link>
        <div><Link href="/pricing">Pricing</Link><Link href={connect}>Connect channels</Link><Link href="/legal/privacy">Privacy</Link><Link href="/legal/terms">Terms</Link></div>
      </footer>
    </main>
  );
}
