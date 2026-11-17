import Link from 'next/link';

export default function LoginError() {
  return (
    <main className="identity-shell">
      <p className="wordmark">CadenceDesk AI</p>
      <h1>Sign-in link unavailable</h1>
      <p>Request a fresh link and open it from your most recent CadenceDesk email.</p>
      <Link href="/login">Back to sign in</Link>
    </main>
  );
}
