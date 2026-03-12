import { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import Redis from 'ioredis';

interface RateLimitConfig {
  redis: Redis;
}

async function rateLimitPlugin(
  fastify: FastifyInstance,
  opts: RateLimitConfig
): Promise<void> {
  const maxAnon = parseInt(process.env.RATE_LIMIT_MAX_ANON || '30', 10);
  const maxAuth = parseInt(process.env.RATE_LIMIT_MAX_AUTH || '200', 10);
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

  await fastify.register(import('@fastify/rate-limit'), {
    global: true,
    max: (request: FastifyRequest) => {
      // Authenticated users get a higher rate limit
      const authorization = request.headers.authorization;
      if (authorization && authorization.startsWith('Bearer ')) {
        return maxAuth;
      }
      return maxAnon;
    },
    timeWindow: windowMs,
    redis: opts.redis,
    keyGenerator: (request: FastifyRequest) => {
      // Use wallet address from JWT if available, otherwise use IP
      try {
        const authorization = request.headers.authorization;
        if (authorization && authorization.startsWith('Bearer ')) {
          const token = authorization.slice(7);
          // Decode without verifying for rate-limit key extraction
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(
              Buffer.from(parts[1], 'base64url').toString('utf-8')
            );
            if (payload.wallet) {
              return `rl:wallet:${payload.wallet}`;
            }
          }
        }
      } catch {
        // Fall through to IP-based limiting
      }
      return `rl:ip:${request.ip}`;
    },
    errorResponseBuilder: (_request: FastifyRequest, context) => {
      return {
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Please retry after ${Math.ceil(context.ttl / 1000)} seconds.`,
        statusCode: 429,
        retryAfter: Math.ceil(context.ttl / 1000),
      };
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });
}

export default fp(rateLimitPlugin, {
  name: 'rate-limit-plugin',
});
