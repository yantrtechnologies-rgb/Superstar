import Link from 'next/link';
import { googleSignInConfig, passwordSignInConfigured, signInConfigured } from '../../lib/auth-config';
import { GoogleButton } from './google-button';
import { databaseState } from '../../lib/db-wake';
import { loginAction, passwordLoginAction } from './actions';
import { DatabaseWaking } from './database-waking';
import { SubmitButton } from './submit-button';

export const dynamic = 'force-dynamic';

const errors: Record<string, string> = {
  invalid: 'That email and password did not match. Check them and try again.',
  locked: 'Too many attempts. Wait 15 minutes, or use an email sign-in link below.',
  unavailable: 'Password sign-in is not configured on this server.',
  unverified: 'Confirm your email address first. Sign in with your password to get a new confirmation link, or use an email sign-in link below.',
};

export default async function Login({ searchParams }: { searchParams: Promise<{ intent?: string; error?: string }> }) {
  const { intent, error } = await searchParams;
  const passwords = passwordSignInConfigured();
  const links = signInConfigured();
  const database = await databaseState();
  if (!database.ready) {
    return (
      <main className="identity-shell">
        <Link href="/" className="wordmark">Superstar</Link>
        <h1>Sign in</h1>
        <DatabaseWaking state={database} />
      </main>
    );
  }
  return (
    <main className="identity-shell">
      <Link href="/" className="wordmark">Superstar</Link>
      <h1>Sign in</h1>
      {error && Object.hasOwn(errors, error) && <p role="status" className="status-error">{errors[error]}</p>}
      {googleSignInConfig() && <GoogleButton intent={intent} label="Sign in with Google" />}
      {passwords && (
        <form action={passwordLoginAction} className="identity-form">
          {intent === 'channels' && <input type="hidden" name="intent" value="channels" />}
          <label htmlFor="password-email">Email address</label>
          <input id="password-email" type="email" name="email" autoComplete="username" maxLength={254} required />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" name="password" autoComplete="current-password" maxLength={200} required />
          <SubmitButton className="primary" pending="Signing in…">Sign in</SubmitButton>
          <p>New here? <Link href={intent === 'channels' ? '/signup?intent=channels' : '/signup'}>Create an account</Link></p>
        </form>
      )}
      {links ? (
        <form action={loginAction} className="identity-form">
          <h2>{passwords ? 'Or get a one-time sign-in link' : 'Get a sign-in link'}</h2>
          <p>Enter your work email to receive a one-time sign-in link.</p>
          {intent === 'channels' && <input type="hidden" name="intent" value="channels" />}
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" name="email" autoComplete="email" maxLength={254} required />
          <SubmitButton className={passwords ? '' : 'primary'} pending="Sending link…">Send sign-in link</SubmitButton>
        </form>
      ) : !passwords && <p>Ask your workspace operator to configure sign-in.</p>}
    </main>
  );
}
