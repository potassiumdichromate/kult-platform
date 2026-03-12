// =============================================================================
// KULT Platform — ioredis Client Singleton
//
// Provides a single Redis client instance with:
//   - Exponential back-off retry strategy
//   - Connection event logging
//   - Graceful shutdown helper
//   - Typed JSON get/set helpers with TTL
//   - Pub/Sub factory (separate connection required per ioredis spec)
// =============================================================================

import Redis from 'ioredis';
import { config } from '../config/index.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type RedisClient = Redis;

// ---------------------------------------------------------------------------
// Retry strategy
// ---------------------------------------------------------------------------

/**
 * Exponential back-off, capped at 30 s, with a limit of 30 attempts.
 * Returning `null` stops retrying and emits an `error` event.
 */
function retryStrategy(times: number): number | null {
  if (times > 30) {
    console.error('[redis] Max reconnection attempts reached. Giving up.');
    return null;
  }
  // 2^n * 100 ms, capped at 30_000 ms
  return Math.min(2 ** times * 100, 30_000);
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function createClient(lazyConnect = false): Redis {
  const client = new Redis(config.REDIS_URL, {
    lazyConnect,
    retryStrategy,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    // Keep-alive so idle connections are not dropped by firewalls
    keepAlive: 30_000,
    // Prefix all keys with the namespace for easy identification
    keyPrefix: 'kult:',
  });

  client.on('connect', () =>
    console.info('[redis] Connecting to Redis…')
  );
  client.on('ready', () =>
    console.info('[redis] Redis connection established and ready.')
  );
  client.on('error', (err: Error) =>
    console.error('[redis] Redis error:', err.message)
  );
  client.on('close', () =>
    console.warn('[redis] Redis connection closed.')
  );
  client.on('reconnecting', (ms: number) =>
    console.info(`[redis] Reconnecting in ${ms} ms…`)
  );
  client.on('end', () =>
    console.warn('[redis] Redis connection ended.')
  );

  return client;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __kultRedisClient: Redis | undefined;
}

/**
 * The shared ioredis client.
 *
 * ```ts
 * import { redis } from '@kult/shared/redis';
 * await redis.set('foo', 'bar');
 * ```
 */
export const redis: Redis =
  config.NODE_ENV === 'production'
    ? createClient()
    : (globalThis.__kultRedisClient ??
       (globalThis.__kultRedisClient = createClient()));

// ---------------------------------------------------------------------------
// Pub/Sub clients
// (Each pub/sub pair requires its own dedicated connection.)
// ---------------------------------------------------------------------------

/**
 * Creates a *new* Redis connection suitable for subscribing to channels.
 * The caller is responsible for calling `.disconnect()` when done.
 */
export function createSubscriber(): Redis {
  return createClient(true);
}

/**
 * Creates a *new* Redis connection suitable for publishing messages.
 * For most use cases the regular `redis` client can publish; create a
 * dedicated publisher only if you have strict isolation requirements.
 */
export function createPublisher(): Redis {
  return createClient(true);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Quits the singleton client gracefully, waiting for pending commands.
 */
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Returns `true` if Redis is reachable. Safe to call from `/health`.
 */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Typed JSON helpers
// ---------------------------------------------------------------------------

/**
 * Serialises `value` to JSON and stores it with an optional TTL in seconds.
 *
 * ```ts
 * await setJson('session:abc', { userId: '1' }, 3600);
 * ```
 */
export async function setJson<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  const serialised = JSON.stringify(value);
  if (ttlSeconds !== undefined && ttlSeconds > 0) {
    await redis.set(key, serialised, 'EX', ttlSeconds);
  } else {
    await redis.set(key, serialised);
  }
}

/**
 * Retrieves a JSON-serialised value from Redis.
 * Returns `null` if the key does not exist or has expired.
 *
 * ```ts
 * const session = await getJson<Session>('session:abc');
 * ```
 */
export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Deletes one or more keys.
 */
export async function deleteKeys(...keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  return redis.del(...keys);
}

/**
 * Returns the remaining TTL of a key in seconds.
 * Returns `-1` if the key has no TTL, `-2` if the key does not exist.
 */
export async function getTTL(key: string): Promise<number> {
  return redis.ttl(key);
}

/**
 * Atomically increments a counter and optionally sets an expiry.
 * Useful for rate limiting.
 *
 * ```ts
 * const count = await incrementCounter('ratelimit:ip:1.2.3.4', 60);
 * ```
 */
export async function incrementCounter(
  key: string,
  ttlSeconds?: number
): Promise<number> {
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  if (ttlSeconds !== undefined) {
    pipeline.expire(key, ttlSeconds);
  }
  const results = await pipeline.exec();
  const incrResult = results?.[0];
  if (!incrResult || incrResult[0]) {
    throw new Error(`[redis] incrementCounter failed for key: ${key}`);
  }
  return incrResult[1] as number;
}

/**
 * Adds a member to a sorted set and returns the new cardinality.
 * Useful for the matchmaking queue.
 *
 * ```ts
 * await zaddMember('queue:matchmaking', Date.now(), agentId);
 * ```
 */
export async function zaddMember(
  key: string,
  score: number,
  member: string
): Promise<number> {
  return redis.zadd(key, score, member);
}

/**
 * Returns all members of a sorted set with their scores, ordered ascending.
 */
export async function zrangeWithScores(
  key: string,
  start = 0,
  stop = -1
): Promise<Array<{ member: string; score: number }>> {
  const raw = await redis.zrange(key, start, stop, 'WITHSCORES');
  const result: Array<{ member: string; score: number }> = [];
  for (let i = 0; i < raw.length; i += 2) {
    result.push({
      member: raw[i] as string,
      score: parseFloat(raw[i + 1] as string),
    });
  }
  return result;
}
