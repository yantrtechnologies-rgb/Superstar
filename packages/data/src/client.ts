import { PrismaClient } from '@prisma/client';

const globalDb = globalThis as typeof globalThis & { cadencedeskPrisma?: PrismaClient };
export const prisma = globalDb.cadencedeskPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalDb.cadencedeskPrisma = prisma;
}
