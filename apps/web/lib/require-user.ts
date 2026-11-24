import { findMembership } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '../auth';
import { signInConfigured } from './auth-config';
import { databaseState } from './db-wake';

// One session lookup per request, shared by the layout and the page (each database round trip costs ~0.3 s).
// If the database is asleep, send the visitor to the sign-in page, which starts it and waits.
const currentSession = cache(async () => {
  try {
    return await auth();
  } catch (error) {
    if (!(await databaseState()).ready) redirect('/login');
    throw error;
  }
});

export async function requireUser(loginPath: '/login' | '/login?intent=channels' = '/login') {
  if (!signInConfigured()) redirect(loginPath);
  const session = await currentSession();
  if (!session?.user.id || !session.user.email) redirect(loginPath);
  // Unconfirmed accounts (password sign-ups that never clicked the email link) cannot use the app.
  if (!session.user.verified && signInConfigured()) redirect('/login?error=unverified');
  return { id: session.user.id, email: session.user.email };
}

/** Workspace membership for this request; the layout and the page share one query. */
export const getMembership = cache((userId: string, slug: string) => findMembership(userId, slug));
