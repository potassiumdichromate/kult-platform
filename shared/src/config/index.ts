// =============================================================================
// KULT Platform — Centralised Environment Configuration
// Uses Zod for strict validation at startup. The process will exit with a
// descriptive error if any required variable is missing or malformed.
// =============================================================================

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const envSchema = z.object({
  // Application
  NODE_ENV: z
    .enum(['development', 'staging', 'production'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'http', 'debug'])
    .default('info'),

  // PostgreSQL
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),

  // MongoDB
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // Redis
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // JWT
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Blockchain
  BLOCKCHAIN_RPC_URL: z
    .string()
    .url('BLOCKCHAIN_RPC_URL must be a valid URL'),
  CHAIN_ID: z.coerce
    .number()
    .int()
    .positive('CHAIN_ID must be a positive integer'),

  // Contract Addresses — checksummed EVM addresses
  AGENT_REGISTRY_CONTRACT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'AGENT_REGISTRY_CONTRACT must be a valid EVM address'),
  GAME_ECONOMY_CONTRACT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'GAME_ECONOMY_CONTRACT must be a valid EVM address'),
  TREASURY_CONTRACT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'TREASURY_CONTRACT must be a valid EVM address'),
  SETTLEMENT_CONTRACT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'SETTLEMENT_CONTRACT must be a valid EVM address'),

  // Hot wallet encryption key — 32+ chars
  ENCRYPTION_KEY: z
    .string()
    .min(32, 'ENCRYPTION_KEY must be at least 32 characters'),

  // Internal service-to-service secret
  INTERNAL_API_SECRET: z
    .string()
    .min(16, 'INTERNAL_API_SECRET must be at least 16 characters'),

  // External services (optional)
  AI_WARZONE_SERVICE_URL: z.string().url().optional(),
  ZERОГ_STORAGE_ENDPOINT: z.string().url().optional(),

  // Service ports
  GATEWAY_PORT: z.coerce.number().int().default(3000),
  AGENT_REGISTRY_PORT: z.coerce.number().int().default(3001),
  MODEL_REGISTRY_PORT: z.coerce.number().int().default(3002),
  AVATAR_AI_PORT: z.coerce.number().int().default(3003),
  ARENA_PORT: z.coerce.number().int().default(3004),
  RANKING_PORT: z.coerce.number().int().default(3005),
  TOURNAMENT_PORT: z.coerce.number().int().default(3006),
  TELEMETRY_PORT: z.coerce.number().int().default(3007),
  WALLET_PORT: z.coerce.number().int().default(3008),
  AI_TRANSACTION_PORT: z.coerce.number().int().default(3009),
  SETTLEMENT_PORT: z.coerce.number().int().default(3010),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // ELO / Matchmaking
  ELO_K_FACTOR: z.coerce.number().default(32),
  ELO_DEFAULT_RATING: z.coerce.number().default(1200),
  MATCHMAKING_MAX_RATING_DIFF: z.coerce.number().default(300),
  MATCHMAKING_TIMEOUT_MS: z.coerce.number().default(30_000),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Config = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Parse & export — fails fast with a clear error if env is invalid
// ---------------------------------------------------------------------------

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(
      `[kult-platform] Environment validation failed:\n${formatted}\n\nCheck your .env file or runtime environment.`
    );
  }

  return result.data;
}

export const config: Config = loadConfig();

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export const isDevelopment = config.NODE_ENV === 'development';
export const isProduction = config.NODE_ENV === 'production';
export const isStaging = config.NODE_ENV === 'staging';

/** Array of configured contract addresses keyed by name */
export const contractAddresses = {
  agentRegistry: config.AGENT_REGISTRY_CONTRACT,
  gameEconomy: config.GAME_ECONOMY_CONTRACT,
  treasury: config.TREASURY_CONTRACT,
  settlement: config.SETTLEMENT_CONTRACT,
} as const;

/** CORS origins parsed from comma-separated string */
export const corsOrigins: string[] = config.CORS_ORIGIN.split(',').map(
  (o) => o.trim()
);
