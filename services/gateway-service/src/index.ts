import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import Redis from 'ioredis';

import { requestLogger, winstonLogger } from './middleware/logger';
import authPlugin from './plugins/auth';
import rateLimitPlugin from './plugins/ratelimit';
import { authRoutes } from './routes/auth';
import { proxyRoutes } from './routes/proxy';
import { setupWebSocketHandler, stopHeartbeat } from './websocket/handler';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false, // We use our own Winston logger
    trustProxy: true,
    requestIdHeader: 'x-request-id',
  });

  // ── Redis ─────────────────────────────────────────────────────────────────
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redis.on('connect', () => winstonLogger.info('Redis connected'));
  redis.on('error', (err) =>
    winstonLogger.error('Redis error', { error: err.message })
  );

  // ── CORS ──────────────────────────────────────────────────────────────────
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  await fastify.register(cors, {
    origin:
      allowedOrigins.length > 0
        ? allowedOrigins
        : process.env.NODE_ENV === 'production'
        ? false
        : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-request-id',
      'x-internal-api-secret',
    ],
  });

  // ── Helmet ────────────────────────────────────────────────────────────────
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Handled by upstream CDN
  });

  // ── JWT ───────────────────────────────────────────────────────────────────
  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────
  await fastify.register(websocket);

  // ── Rate Limiting ─────────────────────────────────────────────────────────
  await fastify.register(rateLimitPlugin, { redis });

  // ── Auth Plugin (preHandler) ──────────────────────────────────────────────
  await fastify.register(authPlugin);

  // ── Request Logger ────────────────────────────────────────────────────────
  fastify.addHook('onRequest', requestLogger);

  // ── Health Check ──────────────────────────────────────────────────────────
  fastify.get('/health', async (request, reply) => {
    let redisOk = false;
    try {
      await redis.ping();
      redisOk = true;
    } catch {
      // redis unavailable
    }

    const status = redisOk ? 'ok' : 'degraded';
    const statusCode = redisOk ? 200 : 503;

    return reply.code(statusCode).send({
      status,
      service: 'gateway-service',
      version: process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString(),
      dependencies: {
        redis: redisOk ? 'ok' : 'unavailable',
      },
    });
  });

  // ── Auth Routes ───────────────────────────────────────────────────────────
  await fastify.register(
    async (instance) => {
      await authRoutes(instance, { redis });
    },
    { prefix: '/auth' }
  );

  // ── WebSocket Handler ─────────────────────────────────────────────────────
  await setupWebSocketHandler(fastify, redis);

  // ── Proxy Routes ──────────────────────────────────────────────────────────
  await fastify.register(proxyRoutes);

  // ── Global Error Handler ──────────────────────────────────────────────────
  fastify.setErrorHandler((error, request, reply) => {
    const requestId = request.headers['x-request-id'] as string;

    winstonLogger.error('Unhandled error', {
      requestId,
      method: request.method,
      url: request.url,
      error: error.message,
      stack: error.stack,
    });

    if (error.validation) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Validation error',
        details: error.validation,
        statusCode: 400,
      });
    }

    const statusCode = error.statusCode || 500;
    return reply.code(statusCode).send({
      error:
        statusCode === 500
          ? 'Internal Server Error'
          : error.message || 'Error',
      message:
        statusCode === 500
          ? 'An unexpected error occurred'
          : error.message,
      statusCode,
      requestId,
    });
  });

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
    });
  });

  return fastify;
}

async function start(): Promise<void> {
  let app: FastifyInstance | null = null;

  try {
    app = await buildApp();
    await app.listen({ port: PORT, host: HOST });
    winstonLogger.info(`Gateway service started`, {
      port: PORT,
      host: HOST,
      nodeEnv: process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    winstonLogger.error('Failed to start gateway service', {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    process.exit(1);
  }

  // ── Graceful Shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    winstonLogger.info(`Received ${signal}, shutting down gracefully...`);
    stopHeartbeat();
    if (app) {
      await app.close();
    }
    winstonLogger.info('Gateway service shut down.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    winstonLogger.error('Uncaught exception', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    winstonLogger.error('Unhandled rejection', { reason });
    process.exit(1);
  });
}

start();
