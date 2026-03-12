import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

// Public routes that do not require authentication
const PUBLIC_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/health$/ },
  { method: 'POST', path: /^\/auth\/nonce$/ },
  { method: 'POST', path: /^\/auth\/wallet$/ },
  { method: 'POST', path: /^\/auth\/refresh$/ },
  { method: 'GET', path: /^\/agents\/leaderboard$/ },
  { method: 'GET', path: /^\/ranking\// },
];

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      sub: string;
      wallet: string;
      iat: number;
      exp: number;
    };
  }
}

function isPublicRoute(method: string, url: string): boolean {
  const pathname = url.split('?')[0];
  return PUBLIC_ROUTES.some(
    (route) => route.method === method && route.path.test(pathname)
  );
}

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook(
    'preHandler',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (isPublicRoute(request.method, request.url)) {
        return;
      }

      const authorization = request.headers.authorization;

      if (!authorization) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Authorization header is required',
          statusCode: 401,
        });
      }

      if (!authorization.startsWith('Bearer ')) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Authorization header must use Bearer scheme',
          statusCode: 401,
        });
      }

      try {
        const payload = await request.jwtVerify<{
          sub: string;
          wallet: string;
          iat: number;
          exp: number;
        }>();
        request.user = payload;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Invalid or expired token';
        return reply.code(401).send({
          error: 'Unauthorized',
          message,
          statusCode: 401,
        });
      }
    }
  );
}

export default fp(authPlugin, {
  name: 'auth-plugin',
  dependencies: ['@fastify/jwt'],
});
