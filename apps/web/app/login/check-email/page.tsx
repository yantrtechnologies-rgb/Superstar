import Link from 'next/link';

export default function CheckEmail() {
  return (
    <main className="identity-shell">
      <p className="wordmark">Superstar</p>
      <h1>Check your inbox</h1>
      <p>We sent you an email with a link. Open it within 15 minutes to confirm your email address and sign in.</p>
      <p>Can't find it? Check your spam folder, or sign in with your password again to get a new link.</p>
      <Link href="/login">Use another email address</Link>
    </main>
  );
}
