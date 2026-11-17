'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { signIn } from '../../auth';
import { signInConfigured } from '../../lib/auth-config';

const emailAddress = z.string().trim().toLowerCase().max(254).pipe(z.email());

export async function loginAction(form: FormData) {
  const email = emailAddress.safeParse(form.get('email'));
  if (!email.success || !signInConfigured()) redirect('/login/error');
  try {
    await signIn('resend', { email: email.data, redirectTo: form.get('intent') === 'channels' ? '/app?intent=channels' : '/app' });
  } catch (error) {
    if (error instanceof AuthError) redirect('/login/error');
    throw error;
  }
}
