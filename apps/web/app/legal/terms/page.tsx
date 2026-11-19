import Link from 'next/link';

export const metadata = {
  title: 'Terms of Service | Superstar',
  description: 'Terms governing use of the Superstar social media management service.',
};

export default function Terms() {
  return (
    <main className="legal-page">
      <nav className="public-nav" aria-label="Legal navigation">
        <Link href="/" className="wordmark">Superstar</Link>
        <div><Link href="/legal/privacy">Privacy</Link><Link href="/legal/data-deletion">Delete data</Link></div>
      </nav>
      <article>
        <p className="legal-kicker">Effective 19 November 2026</p>
        <h1>Terms of Service</h1>
        <p>These terms govern access to Superstar. By using the service, you agree to these terms and confirm that you are able to enter into them.</p>

        <h2>Your account and workspace</h2>
        <p>You are responsible for your account, workspace members and connected channels. Keep access secure, provide accurate information, and notify us if you suspect unauthorized use. Workspace owners control membership and content within their workspace.</p>

        <h2>Connected services</h2>
        <p>Social networks and other integrations are independent services with their own terms, permissions and availability. You authorize Superstar to act on your behalf only for the destinations and actions you select. Provider restrictions or outages may delay or prevent publishing.</p>

        <h2>Acceptable use</h2>
        <p>You must have the rights and permissions needed for content you upload or publish. Do not use Superstar to violate law, intellectual-property rights, privacy rights, provider rules, or to distribute malware, deceptive content, harassment or unlawful material.</p>

        <h2>Availability and changes</h2>
        <p>We work to provide a reliable service but do not guarantee uninterrupted availability. Features may change as provider APIs, permissions and requirements change. We may suspend access to protect users, providers or the service.</p>

        <h2>Content and responsibility</h2>
        <p>You retain ownership of your content and grant Superstar the limited permission required to store, process and transmit it as you direct. You are responsible for reviewing schedules, destinations and approvals before publication.</p>

        <h2>Disclaimers and liability</h2>
        <p>The service is provided on an “as available” basis to the extent permitted by law. Superstar is not responsible for provider actions, account restrictions, missed opportunities, or indirect or consequential loss. Nothing in these terms excludes liability that cannot legally be excluded.</p>

        <h2>Termination and contact</h2>
        <p>You may stop using the service and request deletion at any time. We may terminate access for material violations, security risks or legal requirements. Questions can be sent to <a href="mailto:xolnettechnologies@gmail.com">xolnettechnologies@gmail.com</a>.</p>
      </article>
    </main>
  );
}
