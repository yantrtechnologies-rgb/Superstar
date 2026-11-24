// Sets a sign-in password for an existing user, or creates the user if --create is passed.
// Usage: node scripts/set-password.mjs <email> [--create] [--generate | --password-file <path>]
// --generate writes a new random password to .local-admin-login.txt (git-ignored) instead of printing it.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [join(root, 'apps/web/.env.local'), join(root, '.env.local-stack')]) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* optional file */ }
}
const [email, ...flags] = process.argv.slice(2);
if (!email) { console.error('Usage: node scripts/set-password.mjs <email> [--create] [--generate | --password-file <path>]'); process.exit(2); }
const data = await import(pathToFileURL(join(root, 'packages/data/dist/index.js')).href);
const { prisma, hashPassword, loginEmail } = data.default ?? data;

let password;
if (flags.includes('--generate')) password = randomBytes(18).toString('base64url');
else {
  const i = flags.indexOf('--password-file');
  if (i < 0) { console.error('Pass --generate or --password-file <path>.'); process.exit(2); }
  password = readFileSync(flags[i + 1], 'utf8').trim();
}
const address = loginEmail.parse(email);
const passwordHash = await hashPassword(password);
const existing = await prisma.user.findUnique({ where: { email: address } });
if (!existing && !flags.includes('--create')) { console.error(`No user ${address}. Pass --create to add one.`); process.exit(1); }
await (existing
  ? prisma.user.update({ where: { id: existing.id }, data: { passwordHash, failedLogins: 0, lockedUntil: null } })
  : prisma.user.create({ data: { email: address, passwordHash, emailVerified: new Date() } }));
if (flags.includes('--generate')) {
  const out = join(root, '.local-admin-login.txt');
  writeFileSync(out, `Superstar sign-in (keep private)\nEmail: ${address}\nPassword: ${password}\nSet: ${new Date().toISOString()}\n`, { mode: 0o600 });
  console.log(`Password for ${address} saved to ${out}`);
} else console.log(`Password updated for ${address}`);
await prisma.$disconnect();
