import { redirect } from 'next/navigation';
import { auth } from '../auth';
import { signInConfigured } from './auth-config';

export async function requireUser() {
  if (!signInConfigured()) redirect('/login');
  const session = await auth();
  if (!session?.user.id || !session.user.email) redirect('/login');
  return { id: session.user.id, email: session.user.email };
}
