import Link from 'next/link';

const schedule = [
  { day: 'MON', date: '16', title: 'Campaign brief', detail: 'Editorial planning', tone: 'paper' },
  { day: 'TUE', date: '17', title: 'Behind the scenes', detail: 'Instagram · In review', tone: 'warm' },
  { day: 'WED', date: '18', title: 'Field notes', detail: 'LinkedIn · Scheduled', tone: 'mint' },
  { day: 'THU', date: '19', title: 'Studio dispatch', detail: 'Newsletter · Draft', tone: 'paper' },
];

export default function Home() {
  return (
    <main className="public-home">
      <nav className="public-nav" aria-label="Main navigation">
        <Link href="/" className="wordmark">CadenceDesk AI</Link>
        <div><Link href="/pricing">View plans</Link><Link href="/login" className="primary">Sign in</Link></div>
      </nav>
      <section className="public-hero">
        <div>
          <h1>A workspace for social campaigns</h1>
          <p>Plan content, review drafts with clients, and schedule posts for each channel.</p>
          <Link href="/login" className="primary">Sign in to CadenceDesk</Link>
        </div>
        <figure className="agenda-preview">
          <figcaption><span>Fieldwork Studio</span><strong>Campaign agenda</strong></figcaption>
          <ol aria-label="Sample campaign agenda">
            {schedule.map((item) => (
              <li key={item.date}>
                <time dateTime={'2026-11-' + item.date}><small>{item.day}</small>{item.date}</time>
                <div className={'agenda-preview-item ' + item.tone}><strong>{item.title}</strong><span>{item.detail}</span></div>
              </li>
            ))}
          </ol>
        </figure>
      </section>
      <section className="public-workflow" aria-label="Campaign workflow">
        <div><h2>Plan</h2><p>See scheduled posts alongside the drafts still in progress.</p></div>
        <div><h2>Review</h2><p>Share a draft with clients and collect approval on the right revision.</p></div>
        <div><h2>Publish</h2><p>Schedule by channel and check the outcome for every destination.</p></div>
      </section>
    </main>
  );
}
