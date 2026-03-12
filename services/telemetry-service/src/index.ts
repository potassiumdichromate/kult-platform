import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { TelemetryService } from './services/telemetry.service';
import { telemetryRoutes } from './routes/telemetry';
import { logger } from './middleware/logger';

async function bootstrap(): Promise<void> {
  const mongoUri = process.env['MONGODB_URI'];
  if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  // Connect to MongoDB
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  });
  logger.info('Connected to MongoDB');

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

  const telemetryService = new TelemetryService();

  const fastify = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    trustProxy: true,
  });

  await fastify.register(cors, {
    origin: process.env['CORS_ORIGIN'] ?? false,
    methods: ['GET', 'POST'],
  });

  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  await fastify.register(jwt, { secret: jwtSecret });

  fastify.get('/health', async () => {
    const mongoOk = mongoose.connection.readyState === 1;
    const redisOk = await redis.ping().then((r) => r === 'PONG').catch(() => false);

    return {
      status: mongoOk && redisOk ? 'ok' : 'degraded',
      service: 'telemetry-service',
      timestamp: new Date().toISOString(),
      dependencies: {
        mongodb: mongoOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
      },
    };
  });

  await fastify.register(telemetryRoutes, { telemetryService });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      await fastify.close();
      await mongoose.disconnect();
      redis.disconnect();
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = parseInt(process.env['PORT'] ?? '3005', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await fastify.listen({ port, host });
  logger.info(`Telemetry Service listening on ${host}:${port}`);
}

bootstrap().catch((err) => {
  logger.error('Fatal error starting telemetry-service', { err });
  process.exit(1);
});
