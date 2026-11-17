import Link from 'next/link';

export default function CheckEmail() {
  return (
    <main className="identity-shell">
      <p className="wordmark">Superstar</p>
      <h1>Check your inbox</h1>
      <p>Open the Superstar sign-in link within 15 minutes.</p>
      <Link href="/login">Use another email address</Link>
    </main>
  );
}
