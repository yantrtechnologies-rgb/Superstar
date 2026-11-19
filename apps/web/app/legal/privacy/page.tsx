import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy | Superstar',
  description: 'How Superstar collects, uses and protects account and social-channel data.',
};

export default function PrivacyPolicy() {
  return (
    <main className="legal-page">
      <nav className="public-nav" aria-label="Legal navigation">
        <Link href="/" className="wordmark">Superstar</Link>
        <div><Link href="/legal/terms">Terms</Link><Link href="/legal/data-deletion">Delete data</Link></div>
      </nav>
      <article>
        <p className="legal-kicker">Effective 19 November 2026</p>
        <h1>Privacy Policy</h1>
        <p>Superstar is a social media planning and publishing service. This policy explains what information the service processes, why it is used, and the choices available to you.</p>

        <h2>Information we process</h2>
        <ul>
          <li>Account information, including your email address, workspace membership and authentication records.</li>
          <li>Social-channel information you authorize a provider to share, such as profile or Page identifiers, names, access permissions and connection status.</li>
          <li>Content you create or upload, including drafts, media, schedules, approvals, comments and publishing results.</li>
          <li>Operational information such as audit events, error records, browser and device information, and security logs.</li>
          <li>Subscription and usage records. Payment card details are processed by the payment provider and are not stored by Superstar.</li>
        </ul>

        <h2>Meta, LinkedIn and other connected channels</h2>
        <p>When you connect a channel, Superstar uses the provider authorization you grant to discover destinations you administer and to perform actions you request, such as scheduling, publishing and retrieving supported analytics. Superstar does not publish without an action or schedule created by an authorized workspace member.</p>
        <p>Connection tokens are kept server-side and encrypted at rest. We request only the permissions needed for enabled features. You can disconnect a channel from Superstar or revoke access directly in the provider&apos;s account settings.</p>

        <h2>How information is used</h2>
        <p>We use information to provide and secure the service, publish requested content, maintain schedules and approvals, troubleshoot failures, prevent abuse, support users, and meet legal obligations. We do not sell personal information.</p>

        <h2>Sharing</h2>
        <p>Information is shared only with connected social platforms when fulfilling your request, with infrastructure and service providers acting on our behalf, when required by law, or during a business transfer subject to appropriate safeguards.</p>

        <h2>Retention and security</h2>
        <p>Workspace content is retained while the workspace is active and as needed for recovery, security and legal obligations. Connection credentials are removed when a channel is disconnected, subject to short-lived backups. We use access controls, tenant isolation, encryption and audit records to protect information, but no system can guarantee absolute security.</p>

        <h2>Your choices and deletion requests</h2>
        <p>You may disconnect channels, request access or correction, or request deletion of your Superstar account and associated personal data. Follow the <Link href="/legal/data-deletion">data deletion instructions</Link> or contact us. Some records may be retained where required for security, fraud prevention, billing or law.</p>

        <h2>Changes and contact</h2>
        <p>We may update this policy as the service changes. Material updates will be identified by a revised effective date. Questions or privacy requests can be sent to <a href="mailto:xolnettechnologies@gmail.com">xolnettechnologies@gmail.com</a>.</p>
      </article>
    </main>
  );
}
