'use server';

import {
  authenticatePassword, createPasswordSession, loginEmail, PasswordLoginError, passwordSchema, prisma, registerWithPassword,
} from '@cadencedesk/data';
import { AuthError } from 'next-auth';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { signIn } from '../../auth';
import { passwordSignInConfigured, sessionCookie, signInConfigured } from '../../lib/auth-config';

export async function loginAction(form: FormData) {
  const email = loginEmail.safeParse(form.get('email'));
  if (!email.success || !signInConfigured()) redirect('/login/error');
  await endCurrentSession();
  try {
    await signIn('resend', { email: email.data, redirectTo: form.get('intent') === 'channels' ? '/app?intent=channels' : '/app' });
  } catch (error) {
    if (error instanceof AuthError) redirect('/login/error');
    throw error;
  }
}

async function startSession(userId: string) {
  const { sessionToken, expires } = await createPasswordSession(userId);
  const cookie = sessionCookie();
  (await cookies()).set(cookie.name, sessionToken, {
    httpOnly: true, sameSite: 'lax', path: '/', secure: cookie.secure, expires,
  });
}

function destination(form: FormData) {
  return form.get('intent') === 'channels' ? '/app?intent=channels' : '/app';
}

export async function passwordLoginAction(form: FormData) {
  if (!passwordSignInConfigured()) redirect('/login?error=unavailable');
  await endCurrentSession();
  let user: Awaited<ReturnType<typeof authenticatePassword>>;
  try {
    user = await authenticatePassword(String(form.get('email') ?? ''), String(form.get('password') ?? ''));
  } catch (error) {
    if (error instanceof PasswordLoginError) {
      redirect('/login?error=' + (error.message.startsWith('Too many') ? 'locked' : 'invalid'));
    }
    throw error;
  }
  // Accounts must confirm their email first; send a fresh confirmation link instead of signing in.
  if (!user.emailVerified && signInConfigured()) await sendConfirmation(user.email, form);
  await startSession(user.id);
  redirect(destination(form));
}

/** Emails a one-time link that confirms the address (Auth.js sets emailVerified) and signs the user in. */
async function sendConfirmation(email: string, form: FormData) {
  try {
    await signIn('resend', { email, redirectTo: destination(form) });
  } catch (error) {
    if (error instanceof AuthError) redirect('/login/error');
    throw error;
  }
}

/**
 * Signs out whoever is signed in on this browser before a new sign-in starts. Without this, Auth.js treats
 * a Google sign-in as "add this Google account to the current user" and the person lands in someone else's account.
 */
async function endCurrentSession() {
  const cookie = sessionCookie();
  const jar = await cookies();
  const token = jar.get(cookie.name)?.value;
  if (!token) return;
  await prisma.session.deleteMany({ where: { sessionToken: token } });
  jar.delete(cookie.name);
}

export async function googleSignInAction(form: FormData) {
  await endCurrentSession();
  try {
    await signIn('google', { redirectTo: destination(form) });
  } catch (error) {
    if (error instanceof AuthError) redirect('/login/error');
    throw error;
  }
}

export async function signupAction(form: FormData) {
  if (!passwordSignInConfigured()) redirect('/signup?error=unavailable');
  const email = loginEmail.safeParse(form.get('email'));
  const password = passwordSchema.safeParse(form.get('password'));
  if (!email.success) redirect('/signup?error=email');
  if (!password.success) redirect('/signup?error=password');
  if (form.get('password') !== form.get('confirm')) redirect('/signup?error=mismatch');
  await endCurrentSession();
  let userId: string;
  try {
    const user = await registerWithPassword(email.data, password.data, String(form.get('name') ?? ''));
    userId = user.id;
  } catch (error) {
    if (error instanceof PasswordLoginError) redirect('/signup?error=exists');
    throw error;
  }
  // New accounts confirm their email before they can sign in.
  if (signInConfigured()) await sendConfirmation(email.data, form);
  await startSession(userId);
  redirect(destination(form));
}
