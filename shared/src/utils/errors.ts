// =============================================================================
// KULT Platform — Custom Error Hierarchy
//
// All errors extend KultError which carries an HTTP status code and a
// machine-readable `code` string for client-side error handling.
//
// A Fastify error handler plugin is provided at the bottom of this file.
// =============================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createLogger } from './logger.js';

const log = createLogger('error-handler');

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

export class KultError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_SERVER_ERROR',
    isOperational = true
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    // Restore prototype chain (required when extending built-ins in TypeScript)
    Object.setPrototypeOf(this, new.target.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP 400 — Validation Error
// ---------------------------------------------------------------------------

export class ValidationError extends KultError {
  public readonly fields?: Record<string, string[]>;

  constructor(message: string, fields?: Record<string, string[]>) {
    super(message, 400, 'VALIDATION_ERROR');
    this.fields = fields;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), fields: this.fields };
  }
}

// ---------------------------------------------------------------------------
// HTTP 401 — Unauthorized
// ---------------------------------------------------------------------------

export class UnauthorizedError extends KultError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

// ---------------------------------------------------------------------------
// HTTP 403 — Forbidden
// ---------------------------------------------------------------------------

export class ForbiddenError extends KultError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

// ---------------------------------------------------------------------------
// HTTP 403 — Policy Violation (spending limits, whitelist, etc.)
// ---------------------------------------------------------------------------

export class PolicyViolationError extends KultError {
  public readonly policyCode: string;
  public readonly detail: Record<string, unknown>;

  constructor(
    message: string,
    policyCode: string,
    detail: Record<string, unknown> = {}
  ) {
    super(message, 403, 'POLICY_VIOLATION');
    this.policyCode = policyCode;
    this.detail = detail;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), policyCode: this.policyCode, detail: this.detail };
  }
}

// ---------------------------------------------------------------------------
// HTTP 404 — Not Found
// ---------------------------------------------------------------------------

export class NotFoundError extends KultError {
  public readonly resource: string;

  constructor(resource: string, id?: string) {
    const msg = id
      ? `${resource} with id "${id}" not found`
      : `${resource} not found`;
    super(msg, 404, 'NOT_FOUND');
    this.resource = resource;
  }
}

// ---------------------------------------------------------------------------
// HTTP 409 — Conflict
// ---------------------------------------------------------------------------

export class ConflictError extends KultError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

// ---------------------------------------------------------------------------
// HTTP 429 — Rate Limit
// ---------------------------------------------------------------------------

export class RateLimitError extends KultError {
  public readonly retryAfterMs: number;

  constructor(message = 'Too many requests', retryAfterMs = 60_000) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
    this.retryAfterMs = retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs };
  }
}

// ---------------------------------------------------------------------------
// HTTP 500 — Blockchain Error
// ---------------------------------------------------------------------------

export class BlockchainError extends KultError {
  public readonly txHash?: string;

  constructor(message: string, txHash?: string) {
    super(message, 500, 'BLOCKCHAIN_ERROR', true);
    this.txHash = txHash;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), txHash: this.txHash };
  }
}

// ---------------------------------------------------------------------------
// HTTP 503 — Service Unavailable
// ---------------------------------------------------------------------------

export class ServiceUnavailableError extends KultError {
  public readonly service: string;

  constructor(service: string, message?: string) {
    super(message ?? `${service} is unavailable`, 503, 'SERVICE_UNAVAILABLE');
    this.service = service;
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isKultError(err: unknown): err is KultError {
  return err instanceof KultError;
}

// ---------------------------------------------------------------------------
// Fastify error handler plugin
// ---------------------------------------------------------------------------

/**
 * Registers a global Fastify error handler that:
 *   - Returns structured JSON for all KultError subclasses
 *   - Logs non-operational errors as `error` and operational ones as `warn`
 *   - Handles Fastify validation errors (from Ajv) gracefully
 *   - Returns a generic 500 for unexpected errors (no leaking of stack traces)
 */
async function errorHandlerPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(
    (
      error: Error & {
        statusCode?: number;
        validation?: Array<{ message: string; params?: unknown }>;
      },
      request: FastifyRequest,
      reply: FastifyReply
    ): void => {
      // Fastify/Ajv schema validation errors
      if (error.validation && Array.isArray(error.validation)) {
        const fields: Record<string, string[]> = {};
        for (const v of error.validation) {
          const key = String(
            (v.params as Record<string, unknown> | undefined)?.['missingProperty'] ?? 'body'
          );
          fields[key] = fields[key] ?? [];
          fields[key]!.push(v.message ?? 'Invalid value');
        }
        void reply.code(400).send({
          success: false,
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          fields,
          requestId: request.id,
        });
        return;
      }

      // Our custom error hierarchy
      if (isKultError(error)) {
        if (!error.isOperational) {
          log.error('Unexpected operational error', {
            code: error.code,
            message: error.message,
            stack: error.stack,
            requestId: String(request.id),
            url: request.url,
          });
        } else {
          log.warn('Handled application error', {
            code: error.code,
            statusCode: error.statusCode,
            message: error.message,
            requestId: String(request.id),
            url: request.url,
          });
        }

        void reply.code(error.statusCode).send({
          success: false,
          ...error.toJSON(),
          requestId: request.id,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Unknown / unhandled errors — never leak stack traces in production
      log.error('Unhandled error', {
        message: error.message,
        stack: error.stack,
        requestId: String(request.id),
        url: request.url,
      });

      void reply.code(500).send({
        success: false,
        error: 'An unexpected error occurred',
        code: 'INTERNAL_SERVER_ERROR',
        requestId: request.id,
        timestamp: new Date().toISOString(),
      });
    }
  );
}

export const errorHandlerFastifyPlugin = fp(errorHandlerPlugin, {
  name: 'kult-error-handler',
  fastify: '4.x',
});
