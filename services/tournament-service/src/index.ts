import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { TournamentService } from './services/tournament.service';
import { tournamentRoutes } from './routes/tournament';
import { logger } from './middleware/logger';

async function bootstrap(): Promise<void> {
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

  await prisma.$connect();
  logger.info('Connected to PostgreSQL');

  const tournamentService = new TournamentService(prisma);

  const fastify = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    trustProxy: true,
  });

  await fastify.register(cors, {
    origin: process.env['CORS_ORIGIN'] ?? false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  await fastify.register(jwt, { secret: jwtSecret });

  fastify.get('/health', async () => {
    const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    const redisOk = await redis.ping().then((r) => r === 'PONG').catch(() => false);

    return {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      service: 'tournament-service',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: dbOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
      },
    };
  });

  await fastify.register(tournamentRoutes, { tournamentService });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      await fastify.close();
      await prisma.$disconnect();
      redis.disconnect();
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = parseInt(process.env['PORT'] ?? '3007', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await fastify.listen({ port, host });
  logger.info(`Tournament Service listening on ${host}:${port}`);
}

bootstrap().catch((err) => {
  logger.error('Fatal error starting tournament-service', { err });
  process.exit(1);
});
