import Link from 'next/link';
import { signInConfigured } from '../../lib/auth-config';
import { loginAction } from './actions';

export const dynamic = 'force-dynamic';

export default function Login() {
  return (
    <main className="identity-shell">
      <Link href="/" className="wordmark">CadenceDesk AI</Link>
      <h1>Sign in</h1>
      {signInConfigured() ? (
        <form action={loginAction} className="identity-form">
          <p>Enter your work email to receive a one-time sign-in link.</p>
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" name="email" autoComplete="email" maxLength={254} required />
          <button className="primary" type="submit">Send sign-in link</button>
        </form>
      ) : <p>Ask your workspace operator to configure sign-in email delivery.</p>}
    </main>
  );
}
