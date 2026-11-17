import { Injectable, type OnModuleDestroy, type OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';

const increment = `
  local count = redis.call("INCR", KEYS[1])
  if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
  return count
`;

@Injectable()
export class ApiRateLimit implements OnModuleInit, OnModuleDestroy {
  private readonly redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, {
    lazyConnect: true, enableOfflineQueue: false,
    connectTimeout: 1000, commandTimeout: 1500, maxRetriesPerRequest: 0,
  }) : null;

  async onModuleInit() {
    this.redis?.on('error', () => undefined);
    await this.redis?.connect().catch(() => undefined);
  }

  async onModuleDestroy() {
    this.redis?.disconnect();
  }

  ready() {
    return this.redis?.status === 'ready';
  }

  async consume(keyId: string) {
    const requested = Number(process.env.API_REQUESTS_PER_MINUTE ?? 120);
    const limit = Number.isInteger(requested) && requested > 0 && requested <= 100_000 ? requested : 120;
    const now = Date.now();
    const window = Math.floor(now / 60_000);
    const resetsIn = Math.ceil(((window + 1) * 60_000 - now) / 1000);
    if (!this.redis || !this.ready()) throw new ServiceUnavailableException('API rate limiting is unavailable.');
    try {
      const key = `cadencedesk:api:key:${keyId}:${window}`;
      const count = Number(await this.redis.eval(increment, 1, key, 65_000));
      if (!Number.isInteger(count) || count < 1) throw new Error('Invalid Redis counter');
      return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetsIn };
    } catch {
      throw new ServiceUnavailableException('API rate limiting is unavailable.');
    }
  }
}
