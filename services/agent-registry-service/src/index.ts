import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

import { winstonLogger } from './logger';
import { AgentService } from './services/agent.service';
import { agentRoutes } from './routes/agents';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false,
    trustProxy: true,
    requestIdHeader: 'x-request-id',
  });

  // ── Prisma ────────────────────────────────────────────────────────────────
  const prisma = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'info', 'warn', 'error']
        : ['warn', 'error'],
  });

  try {
    await prisma.$connect();
    winstonLogger.info('Prisma connected to database');
  } catch (err) {
    winstonLogger.error('Failed to connect to database', {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    process.exit(1);
  }

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

  // ── Services ──────────────────────────────────────────────────────────────
  const agentService = new AgentService(prisma, redis);

  // ── Plugins ───────────────────────────────────────────────────────────────
  await fastify.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-request-id',
      'x-internal-api-secret',
      'x-user-wallet',
      'x-user-sub',
    ],
  });

  await fastify.register(helmet, { contentSecurityPolicy: false });

  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
  });

  // ── Request Logging Hook ──────────────────────────────────────────────────
  fastify.addHook('onRequest', (request, reply, done) => {
    winstonLogger.info('Incoming request', {
      method: request.method,
      url: request.url,
      requestId: request.headers['x-request-id'],
    });
    done();
  });

  // ── Health Check ──────────────────────────────────────────────────────────
  fastify.get('/health', async (request, reply) => {
    let dbOk = false;
    let redisOk = false;

    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      // db unavailable
    }

    try {
      await redis.ping();
      redisOk = true;
    } catch {
      // redis unavailable
    }

    const allOk = dbOk && redisOk;
    return reply.code(allOk ? 200 : 503).send({
      status: allOk ? 'ok' : 'degraded',
      service: 'agent-registry-service',
      version: process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: dbOk ? 'ok' : 'unavailable',
        redis: redisOk ? 'ok' : 'unavailable',
      },
    });
  });

  // ── Agent Routes ──────────────────────────────────────────────────────────
  await fastify.register(
    async (instance) => {
      await agentRoutes(instance, { agentService });
    },
    { prefix: '/agents' }
  );

  // ── Error Handler ─────────────────────────────────────────────────────────
  fastify.setErrorHandler((error, request, reply) => {
    winstonLogger.error('Unhandled error', {
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
        statusCode === 500 ? 'Internal Server Error' : error.message || 'Error',
      message:
        statusCode === 500 ? 'An unexpected error occurred' : error.message,
      statusCode,
    });
  });

  fastify.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
    });
  });

  // ── Graceful shutdown hooks ───────────────────────────────────────────────
  fastify.addHook('onClose', async () => {
    winstonLogger.info('Closing Prisma and Redis connections...');
    await prisma.$disconnect();
    redis.disconnect();
  });

  return fastify;
}

async function start(): Promise<void> {
  let app: FastifyInstance | null = null;

  try {
    app = await buildApp();
    await app.listen({ port: PORT, host: HOST });
    winstonLogger.info('Agent registry service started', {
      port: PORT,
      host: HOST,
      nodeEnv: process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    winstonLogger.error('Failed to start agent registry service', {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    winstonLogger.info(`Received ${signal}, shutting down gracefully...`);
    if (app) {
      await app.close();
    }
    winstonLogger.info('Agent registry service shut down.');
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
