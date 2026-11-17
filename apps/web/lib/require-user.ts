import { redirect } from 'next/navigation';
import { auth } from '../auth';
import { signInConfigured } from './auth-config';

export async function requireUser(loginPath: '/login' | '/login?intent=channels' = '/login') {
  if (!signInConfigured()) redirect(loginPath);
  const session = await auth();
  if (!session?.user.id || !session.user.email) redirect(loginPath);
  return { id: session.user.id, email: session.user.email };
}
