import { PrismaClient } from '@prisma/client';

const globalDb = globalThis as typeof globalThis & { cadencedeskPrisma?: PrismaClient };
// Interactive transactions run several queries in a row; against a remote database (~0.3–0.5 s per
// round trip to RDS) Prisma's 5 s default is too short, so allow 20 s to run and 10 s to start.
export const prisma = globalDb.cadencedeskPrisma ?? new PrismaClient({ transactionOptions: { timeout: 20_000, maxWait: 10_000 } });

if (process.env.NODE_ENV !== 'production') {
  globalDb.cadencedeskPrisma = prisma;
}
