import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './client';

/** Thrown for any sign-in failure; the message never reveals whether the email exists. */
export class PasswordLoginError extends Error {}

export const passwordSchema = z.string().min(10, 'Use at least 10 characters.').max(200, 'Use at most 200 characters.');
export const loginEmail = z.string().trim().toLowerCase().max(254).pipe(z.email());

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
export const PASSWORD_SESSION_DAYS = 30;

function derive(password: string, salt: Buffer, n = N, r = R, p = P) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

/** scrypt$N$r$p$saltBase64$hashBase64 */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(passwordSchema.parse(password), salt);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Spends the same scrypt work for unknown emails so response time does not reveal which accounts exist.
const decoy = hashPassword(randomBytes(24).toString('base64url'));

/** Checks an email and password. Locks the account for 15 minutes after 5 consecutive failures. */
export async function authenticatePassword(rawEmail: string, password: string) {
  const email = loginEmail.safeParse(rawEmail);
  if (!email.success || typeof password !== 'string' || password.length > 200) throw new PasswordLoginError('Invalid email or password.');
  const user = await prisma.user.findUnique({ where: { email: email.data } });
  if (!user?.passwordHash) {
    await verifyPassword(password, await decoy);
    throw new PasswordLoginError('Invalid email or password.');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new PasswordLoginError('Too many attempts. Try again in 15 minutes or use an email sign-in link.');
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const failures = user.failedLogins + 1;
    await prisma.user.update({ where: { id: user.id }, data: failures >= MAX_FAILURES
      ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
      : { failedLogins: failures } });
    throw new PasswordLoginError('Invalid email or password.');
  }
  if (user.failedLogins || user.lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  }
  return user;
}

/** Creates a database session identical to the ones Auth.js issues for email links. */
export async function createPasswordSession(userId: string) {
  const sessionToken = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + PASSWORD_SESSION_DAYS * 86_400_000);
  await prisma.session.create({ data: { sessionToken, userId, expires } });
  return { sessionToken, expires };
}

/**
 * Creates an account with a password. Existing emails are refused so a password cannot be
 * attached to someone else's account; their owner sets one after signing in instead.
 * The email stays unverified until the owner signs in once with an email link.
 */
export async function registerWithPassword(rawEmail: string, password: string, name?: string) {
  const email = loginEmail.parse(rawEmail);
  const passwordHash = await hashPassword(password);
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new PasswordLoginError('An account with this email already exists. Sign in instead.');
  }
  return prisma.user.create({ data: { email, passwordHash, name: name?.trim().slice(0, 80) || null } });
}

/** Sets or changes the password for a signed-in user. Changing it requires the current password. */
export async function setUserPassword(userId: string, password: string, currentPassword?: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new PasswordLoginError('Account unavailable.');
  if (user.passwordHash && !(currentPassword && await verifyPassword(currentPassword, user.passwordHash))) {
    throw new PasswordLoginError('Your current password is incorrect.');
  }
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } });
}
