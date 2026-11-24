import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@cadencedesk/data';
import NextAuth from 'next-auth';
import type { Adapter } from 'next-auth/adapters';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import { emailConfig, googleSignInConfig } from './lib/auth-config';
import { deliverEmail } from './lib/mail';

declare module 'next-auth' {
  interface Session {
    user: import('next-auth').DefaultSession['user'] & { id: string; verified: boolean };
  }
}

// Sign-in only needs the Google identity, so provider tokens are dropped instead of stored.
function adapter(): Adapter {
  const base = PrismaAdapter(prisma);
  return {
    ...base,
    linkAccount: (account) => base.linkAccount!({
      ...account, access_token: undefined, refresh_token: undefined, id_token: undefined, expires_at: undefined, session_state: undefined,
    }),
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const config = emailConfig();
  const google = googleSignInConfig();
  return {
    adapter: adapter(),
    session: { strategy: 'database' },
    trustHost: Boolean(config),
    useSecureCookies: config?.url.protocol === 'https:',
    pages: { signIn: '/login', verifyRequest: '/login/check-email', error: '/login/error' },
    providers: [
      ...(config ? [Resend({
        apiKey: config.apiKey,
        from: config.from,
        maxAge: 15 * 60,
        async sendVerificationRequest({ identifier, url }) {
          const link = new URL(url);
          const canonicalLink = new URL(link.pathname + link.search, config.url);
          await deliverEmail(
            identifier,
            'Confirm your email to sign in to Superstar',
            'Confirm your email and sign in',
            'Click the button to confirm this is your email address and sign in to Superstar. The link expires in 15 minutes and works once. If you did not ask for this, ignore this email.',
            canonicalLink.href,
            'Confirm and sign in',
          );
        },
      })] : []),
      ...(google ? [Google({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        // Google only returns verified addresses, so a Google sign-in may join an existing account with the same email.
        allowDangerousEmailAccountLinking: true,
        authorization: { params: { prompt: 'select_account', scope: 'openid email profile' } },
      })] : []),
    ],
    events: {
      // An account created with a password but never confirmed could have been registered by someone else.
      // When the real owner proves the address through Google, remove that unconfirmed password.
      async linkAccount({ user, profile }) {
        // Only when the Google address is this account's own address.
        if (!user.id || !user.email || profile?.email?.toLowerCase() !== user.email.toLowerCase()) return;
        const row = await prisma.user.findUnique({ where: { id: user.id }, select: { emailVerified: true } });
        if (row && !row.emailVerified) {
          await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date(), passwordHash: null } });
        }
      },
    },
    callbacks: {
      // Only accept Google accounts whose email Google has verified.
      signIn: ({ account, profile }) => account?.provider !== 'google' || profile?.email_verified === true,
      session: ({ session, user }) => ({ ...session, user: { ...session.user, id: user.id, verified: Boolean(user.emailVerified) } }),
      redirect: ({ url }) => {
        if (!config) return '/';
        const target = new URL(url, config.url);
        return target.origin === config.url.origin ? target.href : config.url.href;
      },
    },
  };
});
