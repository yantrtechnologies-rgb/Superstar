import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@cadencedesk/data';
import NextAuth from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { emailConfig } from './lib/auth-config';
import { deliverEmail } from './lib/mail';

declare module 'next-auth' {
  interface Session {
    user: import('next-auth').DefaultSession['user'] & { id: string };
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const config = emailConfig();
  return {
    adapter: PrismaAdapter(prisma),
    session: { strategy: 'database' },
    trustHost: Boolean(config),
    useSecureCookies: config?.url.protocol === 'https:',
    pages: { signIn: '/login', verifyRequest: '/login/check-email', error: '/login/error' },
    providers: config ? [Resend({
      apiKey: config.apiKey,
      from: config.from,
      maxAge: 15 * 60,
      async sendVerificationRequest({ identifier, url }) {
        const link = new URL(url);
        const canonicalLink = new URL(link.pathname + link.search, config.url);
        await deliverEmail(
          identifier,
          'Your CadenceDesk AI sign-in link',
          'Sign in to CadenceDesk',
          'This link expires in 15 minutes and can be used once.',
          canonicalLink.href,
          'Sign in',
        );
      },
    })] : [],
    callbacks: {
      session: ({ session, user }) => ({ ...session, user: { ...session.user, id: user.id } }),
      redirect: ({ url }) => {
        if (!config) return '/';
        const target = new URL(url, config.url);
        return target.origin === config.url.origin ? target.href : config.url.href;
      },
    },
  };
});
