import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { validateEncryptionKey } from './services/encryption.service';
import { WalletService } from './services/wallet.service';
import { walletRoutes } from './routes/wallets';
import { logger } from './middleware/logger';

async function bootstrap(): Promise<void> {
  // Security: validate encryption key before starting
  validateEncryptionKey();

  const prisma = new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

  const redis = new Redis({
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
    password: process.env['REDIS_PASSWORD'],
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 100, 3000),
  });

  redis.on('error', (err: Error) => {
    logger.error('Redis connection error', { error: err.message });
  });

  // Connect to DB
  await prisma.$connect();
  logger.info('Connected to PostgreSQL');

  const walletService = new WalletService(prisma, redis);

  const fastify = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
    },
    trustProxy: true,
  });

  // Plugins
  await fastify.register(cors, {
    origin: process.env['CORS_ORIGIN'] ?? false,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  await fastify.register(jwt, {
    secret: jwtSecret,
  });

  // Health check
  fastify.get('/health', async () => {
    const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    const redisOk = await redis.ping().then((r) => r === 'PONG').catch(() => false);

    return {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      service: 'wallet-service',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: dbOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
      },
    };
  });

  // Routes
  await fastify.register(walletRoutes, { walletService });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      await fastify.close();
      await prisma.$disconnect();
      redis.disconnect();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = parseInt(process.env['PORT'] ?? '3002', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await fastify.listen({ port, host });
  logger.info(`Wallet Service listening on ${host}:${port}`);
}

bootstrap().catch((err) => {
  logger.error('Fatal error starting wallet service', { err });
  process.exit(1);
});
