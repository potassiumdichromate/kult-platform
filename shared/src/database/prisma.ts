// =============================================================================
// KULT Platform — Prisma Client Singleton
//
// Provides a single PrismaClient instance shared across the entire Node.js
// process, preventing the "too many connections" problem in development (where
// hot-module-reload would otherwise create a new client on every code change).
//
// In production, the module is only ever imported once so the singleton
// pattern adds no overhead.
// =============================================================================

import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';

// ---------------------------------------------------------------------------
// Type augmentation to store singleton on globalThis in dev
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __kultPrismaClient: PrismaClient | undefined;
}

// ---------------------------------------------------------------------------
// Log configuration
// ---------------------------------------------------------------------------

type PrismaLogLevel = 'query' | 'info' | 'warn' | 'error';

function buildLogConfig(): PrismaLogLevel[] {
  if (config.NODE_ENV === 'production') {
    return ['warn', 'error'];
  }
  if (config.NODE_ENV === 'staging') {
    return ['info', 'warn', 'error'];
  }
  // development
  return ['query', 'info', 'warn', 'error'];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: buildLogConfig(),
    datasources: {
      db: {
        url: config.DATABASE_URL,
      },
    },
  });

  // Soft connect — Prisma connects lazily on first query by default; we call
  // $connect() here so startup failures surface immediately.
  void client.$connect().catch((err: unknown) => {
    console.error('[prisma] Failed to connect to database:', err);
    process.exit(1);
  });

  return client;
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * The single PrismaClient instance for this process.
 *
 * Import as:
 * ```ts
 * import { prisma } from '@kult/shared/database';
 * ```
 */
export const prisma: PrismaClient =
  config.NODE_ENV === 'production'
    ? createPrismaClient()
    : (globalThis.__kultPrismaClient ??
       (globalThis.__kultPrismaClient = createPrismaClient()));

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Disconnects Prisma cleanly. Call this in your SIGINT / SIGTERM handlers.
 *
 * ```ts
 * import { disconnectPrisma } from '@kult/shared/database';
 *
 * process.on('SIGTERM', async () => {
 *   await disconnectPrisma();
 *   process.exit(0);
 * });
 * ```
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

// ---------------------------------------------------------------------------
// Health check helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the database is reachable, `false` otherwise.
 * Safe to call from a `/health` endpoint without throwing.
 */
export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transaction helper type
// ---------------------------------------------------------------------------

/**
 * The type of the Prisma interactive-transaction client.
 * Use this for repository method signatures that accept a transaction.
 *
 * ```ts
 * async function createAgent(data: CreateAgentDTO, tx?: PrismaTx) {
 *   const client = tx ?? prisma;
 *   return client.agent.create({ data });
 * }
 * ```
 */
export type PrismaTx = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];
