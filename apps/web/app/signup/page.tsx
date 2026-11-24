import Link from 'next/link';
import { googleSignInConfig, passwordSignInConfigured } from '../../lib/auth-config';
import { GoogleButton } from '../login/google-button';
import { databaseState } from '../../lib/db-wake';
import { signupAction } from '../login/actions';
import { DatabaseWaking } from '../login/database-waking';
import { SubmitButton } from '../login/submit-button';

export const dynamic = 'force-dynamic';

const errors: Record<string, string> = {
  email: 'Enter a valid email address.',
  password: 'Use a password of at least 10 characters.',
  mismatch: 'The two passwords do not match.',
  exists: 'An account with this email already exists. Sign in instead, or use an email sign-in link.',
  unavailable: 'Account creation is not configured on this server.',
};

export default async function Signup({ searchParams }: { searchParams: Promise<{ intent?: string; error?: string }> }) {
  const { intent, error } = await searchParams;
  const database = await databaseState();
  if (!database.ready) {
    return (
      <main className="identity-shell">
        <Link href="/" className="wordmark">Superstar</Link>
        <h1>Create your account</h1>
        <DatabaseWaking state={database} />
      </main>
    );
  }
  return (
    <main className="identity-shell">
      <Link href="/" className="wordmark">Superstar</Link>
      <h1>Create your account</h1>
      {error && Object.hasOwn(errors, error) && <p role="status" className="status-error">{errors[error]}</p>}
      {googleSignInConfig() && <GoogleButton intent={intent} label="Sign up with Google" />}
      {passwordSignInConfigured() ? (
        <form action={signupAction} className="identity-form">
          {intent === 'channels' && <input type="hidden" name="intent" value="channels" />}
          <label htmlFor="name">Name (optional)</label>
          <input id="name" name="name" autoComplete="name" maxLength={80} />
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" name="email" autoComplete="email" maxLength={254} required />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" name="password" autoComplete="new-password" minLength={10} maxLength={200} required aria-describedby="password-help" />
          <p id="password-help">At least 10 characters.</p>
          <label htmlFor="confirm">Confirm password</label>
          <input id="confirm" type="password" name="confirm" autoComplete="new-password" minLength={10} maxLength={200} required />
          <SubmitButton className="primary" pending="Creating account…">Create account</SubmitButton>
          <p>We&apos;ll email you a link to confirm your address before you can use your account.</p>
        </form>
      ) : <p>Ask your workspace operator to configure sign-in.</p>}
      <p>Already have an account? <Link href="/login">Sign in</Link></p>
    </main>
  );
}
