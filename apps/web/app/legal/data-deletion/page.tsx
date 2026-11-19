import Link from 'next/link';

export const metadata = {
  title: 'Data Deletion | Superstar',
  description: 'How to disconnect social channels and request deletion of Superstar account data.',
};

export default function DataDeletion() {
  return (
    <main className="legal-page">
      <nav className="public-nav" aria-label="Legal navigation">
        <Link href="/" className="wordmark">Superstar</Link>
        <div><Link href="/legal/privacy">Privacy</Link><Link href="/legal/terms">Terms</Link></div>
      </nav>
      <article>
        <p className="legal-kicker">Account and channel data</p>
        <h1>Data deletion instructions</h1>
        <p>You can remove a connected social account from Superstar at any time. Open <strong>Channels</strong> in your workspace, find the connection, and choose <strong>Disconnect</strong>. You can also revoke Superstar directly from the connected provider&apos;s apps and integrations settings.</p>

        <h2>Request complete account deletion</h2>
        <ol>
          <li>Email <a href="mailto:xolnettechnologies@gmail.com?subject=Superstar%20data%20deletion%20request">xolnettechnologies@gmail.com</a> from the email address used for your Superstar account.</li>
          <li>Use the subject “Superstar data deletion request” and identify the workspace to remove.</li>
          <li>We will verify ownership, confirm the scope of the request, and send a completion notice to the account email.</li>
        </ol>
        <p>Deletion removes active connection credentials, account information and workspace content associated with the verified request. Limited records may remain where required for security, fraud prevention, financial reporting or law, and encrypted backups expire on their normal retention cycle.</p>
      </article>
    </main>
  );
}
