import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { createLogger, format, transports } from 'winston';
import { matchRoutes } from './routes/matches';
import { MatchmakingWorker } from './workers/matchmaking.worker';

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'arena-service' },
  transports: [new transports.Console()],
});

// ─── Prisma client ────────────────────────────────────────────────────────────
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

// ─── Redis client ─────────────────────────────────────────────────────────────
const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  maxRetriesPerRequest: null, // Required for BullMQ
});

redis.on('error', (err) => logger.error('Redis connection error', { error: err.message }));
redis.on('connect', () => logger.info('Redis connected'));

// ─── Build server ─────────────────────────────────────────────────────────────
async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
    trustProxy: true,
    ajv: { customOptions: { strict: false } },
  });

  await server.register(fastifyCors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['*'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await server.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production-please',
    sign: { expiresIn: '7d' },
  });

  // Request logging
  server.addHook('onRequest', async (request) => {
    logger.info('Incoming request', {
      method: request.method,
      url: request.url,
      requestId: request.id,
    });
  });

  server.addHook('onResponse', async (request, reply) => {
    logger.info('Request completed', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      requestId: request.id,
    });
  });

  // Health check
  server.get('/health', async (_request, reply) => {
    let dbStatus = 'ok';
    let redisStatus = 'ok';

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    try {
      await redis.ping();
    } catch {
      redisStatus = 'error';
    }

    const healthy = dbStatus === 'ok' && redisStatus === 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'arena-service',
      timestamp: new Date().toISOString(),
      checks: { database: dbStatus, redis: redisStatus },
    });
  });

  // Register match routes
  await server.register(matchRoutes, { prisma, redis, logger });

  return server;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const server = await buildServer();

  // Start matchmaking worker
  const matchmakingWorker = new MatchmakingWorker(redis, prisma, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      await server.close();
      await matchmakingWorker.close();
      await prisma.$disconnect();
      await redis.quit();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  // Connect dependencies
  try {
    await redis.connect();
    await prisma.$connect();
    logger.info('Database connected');
  } catch (err) {
    logger.error('Failed to connect to dependencies', { error: err });
    process.exit(1);
  }

  // Start matchmaking worker
  await matchmakingWorker.start();
  logger.info('Matchmaking worker started');

  const port = parseInt(process.env.PORT ?? '3004', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    const address = await server.listen({ port, host });
    logger.info('Arena Service started', { address, port, host });
  } catch (err) {
    logger.error('Failed to start server', { error: err });
    process.exit(1);
  }
}

void main();
