import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { winstonLogger } from '../middleware/logger';

interface ProxyRoute {
  prefix: string;
  upstream: string;
  requireAuth: boolean;
}

const PROXY_ROUTES: ProxyRoute[] = [
  {
    prefix: '/agents',
    upstream:
      process.env.AGENT_REGISTRY_SERVICE_URL ||
      'http://agent-registry-service:3001',
    requireAuth: false,
  },
  {
    prefix: '/models',
    upstream:
      process.env.MODEL_REGISTRY_SERVICE_URL ||
      'http://model-registry-service:3002',
    requireAuth: true,
  },
  {
    prefix: '/avatar',
    upstream:
      process.env.AVATAR_AI_SERVICE_URL || 'http://avatar-ai-service:3003',
    requireAuth: true,
  },
  {
    prefix: '/arena',
    upstream: process.env.ARENA_SERVICE_URL || 'http://arena-service:3004',
    requireAuth: true,
  },
  {
    prefix: '/ranking',
    upstream:
      process.env.RANKING_SERVICE_URL || 'http://ranking-service:3005',
    requireAuth: false,
  },
  {
    prefix: '/tournaments',
    upstream:
      process.env.TOURNAMENT_SERVICE_URL || 'http://tournament-service:3006',
    requireAuth: false,
  },
  {
    prefix: '/telemetry',
    upstream:
      process.env.TELEMETRY_SERVICE_URL || 'http://telemetry-service:3007',
    requireAuth: true,
  },
  {
    prefix: '/wallet',
    upstream:
      process.env.WALLET_SERVICE_URL || 'http://wallet-service:3008',
    requireAuth: true,
  },
  {
    prefix: '/transactions',
    upstream:
      process.env.AI_TRANSACTION_SERVICE_URL ||
      'http://ai-transaction-service:3009',
    requireAuth: true,
  },
  {
    prefix: '/settlement',
    upstream:
      process.env.SETTLEMENT_SERVICE_URL || 'http://settlement-service:3010',
    requireAuth: true,
  },
];

async function proxyRequest(
  upstream: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const url = new URL(request.url, upstream);
  const headers: Record<string, string> = {
    'content-type': request.headers['content-type'] || 'application/json',
    'x-request-id': (request.headers['x-request-id'] as string) || '',
    'x-forwarded-for': request.ip,
    'x-forwarded-host': request.hostname,
  };

  if (request.user) {
    headers['x-user-wallet'] = request.user.wallet;
    headers['x-user-sub'] = request.user.sub;
  }

  // Forward internal API secret if present
  if (request.headers['x-internal-api-secret']) {
    headers['x-internal-api-secret'] = request.headers[
      'x-internal-api-secret'
    ] as string;
  }

  const fetchOptions: RequestInit = {
    method: request.method,
    headers,
    signal: AbortSignal.timeout(30_000),
  };

  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.method !== 'DELETE'
  ) {
    fetchOptions.body =
      request.body != null ? JSON.stringify(request.body) : undefined;
  }

  try {
    const response = await fetch(url.toString(), fetchOptions);

    // Forward response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (
        ![
          'transfer-encoding',
          'connection',
          'keep-alive',
          'upgrade',
        ].includes(key.toLowerCase())
      ) {
        responseHeaders[key] = value;
      }
    });

    reply.code(response.status).headers(responseHeaders);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await response.json();
      return reply.send(body);
    } else {
      const body = await response.text();
      return reply.send(body);
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Upstream service error';
    winstonLogger.error('Proxy request failed', {
      upstream,
      url: request.url,
      error: message,
    });

    if (
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('timeout'))
    ) {
      return reply.code(504).send({
        error: 'Gateway Timeout',
        message: 'Upstream service did not respond in time.',
        statusCode: 504,
      });
    }

    return reply.code(502).send({
      error: 'Bad Gateway',
      message: 'Upstream service is unavailable.',
      statusCode: 502,
    });
  }
}

export async function proxyRoutes(fastify: FastifyInstance): Promise<void> {
  for (const route of PROXY_ROUTES) {
    const { prefix, upstream } = route;

    // Register a wildcard route for each HTTP method
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

    for (const method of methods) {
      fastify.route({
        method,
        url: `${prefix}`,
        handler: async (request, reply) => {
          return proxyRequest(upstream, request, reply);
        },
      });

      fastify.route({
        method,
        url: `${prefix}/*`,
        handler: async (request, reply) => {
          return proxyRequest(upstream, request, reply);
        },
      });
    }

    winstonLogger.info('Proxy route registered', { prefix, upstream });
  }
}
