import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { TransactionService } from './services/transaction.service';
import { transactionRoutes } from './routes/transactions';
import { createTransactionWorker } from './workers/transaction.worker';
import { validateWhitelist } from './config/whitelist';
import { logger } from './middleware/logger';

async function bootstrap(): Promise<void> {
  // Validate contract whitelist at startup
  validateWhitelist();

  const prisma = new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

  const redis = new Redis({
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
    password: process.env['REDIS_PASSWORD'],
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
  });

  redis.on('error', (err: Error) => {
    logger.error('Redis connection error', { error: err.message });
  });

  await prisma.$connect();
  logger.info('Connected to PostgreSQL');

  // Start BullMQ worker
  const worker = createTransactionWorker(prisma, redis);
  logger.info('Transaction worker started');

  const transactionService = new TransactionService(prisma, redis);

  const fastify = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    trustProxy: true,
  });

  await fastify.register(cors, {
    origin: process.env['CORS_ORIGIN'] ?? false,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  await fastify.register(jwt, { secret: jwtSecret });

  // Health check
  fastify.get('/health', async () => {
    const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    const redisOk = await redis.ping().then((r) => r === 'PONG').catch(() => false);
    const workerRunning = !worker.isRunning() === false;

    return {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      service: 'ai-transaction-service',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: dbOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
        worker: workerRunning ? 'ok' : 'error',
      },
    };
  });

  await fastify.register(transactionRoutes, { transactionService });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      await worker.close();
      await fastify.close();
      await prisma.$disconnect();
      redis.disconnect();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = parseInt(process.env['PORT'] ?? '3003', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await fastify.listen({ port, host });
  logger.info(`AI Transaction Service listening on ${host}:${port}`);
}

bootstrap().catch((err) => {
  logger.error('Fatal error starting ai-transaction-service', { err });
  process.exit(1);
});
