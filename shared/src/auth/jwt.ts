// =============================================================================
// KULT Platform — JWT Utilities
// Provides token generation, verification, and a Fastify plugin for auth
// middleware. All tokens are signed with HS256.
// =============================================================================

import jwt from 'jsonwebtoken';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config/index.js';
import type { JWTPayload } from '../types/index.js';
import { UnauthorizedError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Signs a JWT and returns the token string.
 * The `iat` and `exp` fields are injected automatically by jsonwebtoken; the
 * payload you pass must NOT include them — they are stripped if present.
 */
export function generateToken(
  payload: Omit<JWTPayload, 'iat' | 'exp'>
): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Verifies and decodes a JWT.
 * Throws `UnauthorizedError` for any invalid/expired token.
 */
export function verifyToken(token: string): JWTPayload {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
    });
    return decoded as JWTPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Token has expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new UnauthorizedError('Invalid token');
    }
    throw new UnauthorizedError('Token verification failed');
  }
}

// ---------------------------------------------------------------------------
// Bearer token extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the raw token from an `Authorization: Bearer <token>` header.
 * Returns `null` if the header is absent or malformed.
 */
export function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers['authorization'];
  if (!authHeader || typeof authHeader !== 'string') return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return null;

  return parts[1] ?? null;
}

// ---------------------------------------------------------------------------
// Fastify plugin — JWT authentication middleware
// ---------------------------------------------------------------------------

/**
 * Registers two Fastify decorators:
 *   - `request.jwtPayload` — decoded JWT payload (after authentication)
 *   - `fastify.authenticate`  — preHandler hook that enforces JWT auth
 *
 * Usage:
 * ```ts
 * fastify.register(jwtPlugin);
 *
 * fastify.get('/protected', {
 *   preHandler: [fastify.authenticate],
 * }, handler);
 * ```
 */
async function jwtAuthPlugin(fastify: FastifyInstance): Promise<void> {
  // Decorate request with jwtPayload slot
  fastify.decorateRequest('jwtPayload', null);

  /**
   * Authentication preHandler — call as `preHandler: [fastify.authenticate]`
   */
  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    const token = extractBearerToken(request);

    if (!token) {
      return reply.code(401).send({
        success: false,
        error: 'Missing authorization token',
      });
    }

    try {
      const payload = verifyToken(token);
      // Attach payload to request so handlers can read it
      (request as FastifyRequest & { jwtPayload: JWTPayload }).jwtPayload =
        payload;
    } catch (err) {
      const message =
        err instanceof UnauthorizedError ? err.message : 'Invalid token';
      return reply.code(401).send({ success: false, error: message });
    }
  };

  fastify.decorate('authenticate', authenticate);
}

export const jwtPlugin = fp(jwtAuthPlugin, {
  name: 'kult-jwt-auth',
  fastify: '4.x',
});

// ---------------------------------------------------------------------------
// Internal service authentication
// ---------------------------------------------------------------------------

/**
 * Verifies the `x-internal-api-secret` header for service-to-service calls.
 * Throws `UnauthorizedError` on failure.
 */
export function verifyInternalSecret(request: FastifyRequest): void {
  const secret = request.headers['x-internal-api-secret'];
  if (!secret || secret !== config.INTERNAL_API_SECRET) {
    throw new UnauthorizedError('Invalid internal API secret');
  }
}

/**
 * Fastify preHandler for internal-only routes.
 */
export async function internalAuthHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    verifyInternalSecret(request);
  } catch {
    return reply.code(401).send({
      success: false,
      error: 'Unauthorized — internal route',
    });
  }
}

// ---------------------------------------------------------------------------
// Type augmentation for Fastify
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }

  interface FastifyRequest {
    jwtPayload: JWTPayload | null;
  }
}
