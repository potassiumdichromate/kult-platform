// =============================================================================
// KULT Platform — Winston Structured Logger
//
// Features:
//   - JSON format in staging/production, colorised pretty-print in dev
//   - Five log levels: error, warn, info, http, debug
//   - Child logger support (adds `service` and `requestId` fields)
//   - Request ID propagation via AsyncLocalStorage
//   - Redaction of sensitive fields (privateKey, password, token, signature)
// =============================================================================

import winston from 'winston';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config/index.js';

// ---------------------------------------------------------------------------
// Request-ID store
// ---------------------------------------------------------------------------

/**
 * Stores the current request ID in async context.
 * Services should call `requestIdStorage.run(requestId, handler)` inside
 * their Fastify onRequest hooks.
 */
export const requestIdStorage = new AsyncLocalStorage<string>();

// ---------------------------------------------------------------------------
// Sensitive field redaction
// ---------------------------------------------------------------------------

const REDACTED_FIELDS = new Set([
  'password',
  'privateKey',
  'secret',
  'token',
  'signature',
  'encryptedPrivateKey',
  'mnemonic',
  'seed',
]);

function redactSensitiveFields(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACTED_FIELDS.has(key)) {
      redacted[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      redacted[key] = redactSensitiveFields(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Custom log levels
// ---------------------------------------------------------------------------

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
} as const;

const LOG_COLORS = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(LOG_COLORS);

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** Injects requestId from AsyncLocalStorage into every log entry */
const requestIdFormat = winston.format((info) => {
  const requestId = requestIdStorage.getStore();
  if (requestId) {
    info['requestId'] = requestId;
  }
  return info;
})();

/** Redacts sensitive keys before serialising */
const redactFormat = winston.format((info) => {
  const { level, message, timestamp, service, requestId, ...rest } = info;
  const redacted = redactSensitiveFields(rest as Record<string, unknown>);
  return { level, message, timestamp, service, requestId, ...redacted };
})();

const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  requestIdFormat,
  redactFormat,
  winston.format.json()
);

const prettyFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  requestIdFormat,
  winston.format.colorize({ all: true }),
  winston.format.printf(({ level, message, timestamp, service, requestId, ...meta }) => {
    const svc = service ? `[${String(service)}]` : '';
    const rid = requestId ? ` rid=${String(requestId)}` : '';
    const metaStr =
      Object.keys(meta).length > 0
        ? ' ' + JSON.stringify(meta, null, 0)
        : '';
    return `${String(timestamp)} ${level} ${svc}${rid} ${String(message)}${metaStr}`;
  })
);

// ---------------------------------------------------------------------------
// Base logger
// ---------------------------------------------------------------------------

const isPretty = config.NODE_ENV === 'development';

export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  levels: LOG_LEVELS,
  format: isPretty ? prettyFormat : jsonFormat,
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
  exitOnError: false,
});

// ---------------------------------------------------------------------------
// Child logger factory
// ---------------------------------------------------------------------------

export type LogMeta = Record<string, unknown>;

export interface ServiceLogger {
  error(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  http(message: string, meta?: LogMeta): void;
  debug(message: string, meta?: LogMeta): void;
  child(extraMeta: LogMeta): ServiceLogger;
}

/**
 * Creates a child logger pinned to a specific service name.
 *
 * ```ts
 * import { createLogger } from '@kult/shared/utils/logger';
 *
 * const log = createLogger('arena-service');
 * log.info('Match started', { matchId: '...' });
 * ```
 */
export function createLogger(
  serviceName: string,
  extraMeta: LogMeta = {}
): ServiceLogger {
  const child = logger.child({ service: serviceName, ...extraMeta });

  const wrap =
    (level: keyof typeof LOG_LEVELS) =>
    (message: string, meta: LogMeta = {}): void => {
      child[level](message, meta);
    };

  return {
    error: wrap('error'),
    warn: wrap('warn'),
    info: wrap('info'),
    http: wrap('http'),
    debug: wrap('debug'),
    child: (extra: LogMeta) => createLogger(serviceName, { ...extraMeta, ...extra }),
  };
}

// ---------------------------------------------------------------------------
// Fastify request logging middleware helper
// ---------------------------------------------------------------------------

/**
 * Returns a Fastify `onRequest` hook that injects a request ID into
 * AsyncLocalStorage so all downstream log calls include it automatically.
 *
 * ```ts
 * fastify.addHook('onRequest', requestLoggingHook);
 * ```
 */
export function requestLoggingHook(
  request: { id: string | number; method: string; url: string },
  _reply: unknown,
  done: () => void
): void {
  requestIdStorage.run(String(request.id), () => {
    logger.http(`${request.method} ${request.url}`, { requestId: request.id });
    done();
  });
}

// ---------------------------------------------------------------------------
// Default export for convenience
// ---------------------------------------------------------------------------

export default logger;
