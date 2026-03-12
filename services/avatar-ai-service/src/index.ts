import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import Redis from 'ioredis';
import { createLogger, format, transports } from 'winston';
import { avatarRoutes } from './routes/avatar';
import { TrainingWorker } from './workers/training.worker';

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'avatar-ai-service' },
  transports: [new transports.Console()],
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
    let redisStatus = 'ok';

    try {
      await redis.ping();
    } catch {
      redisStatus = 'error';
    }

    const healthy = redisStatus === 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'avatar-ai-service',
      timestamp: new Date().toISOString(),
      checks: { redis: redisStatus },
    });
  });

  // Register avatar routes
  await server.register(avatarRoutes, { redis, logger });

  return server;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const server = await buildServer();

  // Start background training worker
  const trainingWorker = new TrainingWorker(redis, logger);
  logger.info('Training worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      await server.close();
      await trainingWorker.close();
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

  try {
    await redis.connect();
    logger.info('Redis connected');
  } catch (err) {
    logger.error('Failed to connect to Redis', { error: err });
    process.exit(1);
  }

  const port = parseInt(process.env.PORT ?? '3003', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    const address = await server.listen({ port, host });
    logger.info('Avatar AI Service started', { address, port, host });
  } catch (err) {
    logger.error('Failed to start server', { error: err });
    process.exit(1);
  }
}

void main();
