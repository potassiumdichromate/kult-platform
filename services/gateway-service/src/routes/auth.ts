import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ethers } from 'ethers';
import Redis from 'ioredis';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { winstonLogger } from '../middleware/logger';

const NonceRequestSchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum wallet address'),
});

const WalletAuthSchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum wallet address'),
  signature: z.string().min(1, 'Signature is required'),
  nonce: z.string().uuid('Nonce must be a valid UUID'),
});

const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

const NONCE_TTL_SECONDS = 300; // 5 minutes
const NONCE_PREFIX = 'nonce:';
const REFRESH_TOKEN_PREFIX = 'refresh:';
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function buildSignMessage(wallet: string, nonce: string): string {
  return (
    `Welcome to KULT AI Gaming Platform!\n\n` +
    `Sign this message to authenticate your wallet.\n\n` +
    `Wallet: ${wallet}\n` +
    `Nonce: ${nonce}\n` +
    `This request will not trigger a blockchain transaction or cost any gas fees.`
  );
}

export async function authRoutes(
  fastify: FastifyInstance,
  opts: { redis: Redis }
): Promise<void> {
  const { redis } = opts;

  /**
   * POST /auth/nonce
   * Returns a one-time nonce for the client to sign with their wallet.
   */
  fastify.post(
    '/auth/nonce',
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ) => {
      const parseResult = NonceRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { wallet } = parseResult.data;
      const normalizedWallet = wallet.toLowerCase();
      const nonce = uuidv4();
      const message = buildSignMessage(normalizedWallet, nonce);

      await redis.setex(
        `${NONCE_PREFIX}${normalizedWallet}`,
        NONCE_TTL_SECONDS,
        nonce
      );

      winstonLogger.info('Nonce issued', { wallet: normalizedWallet });

      return reply.code(200).send({
        nonce,
        message,
        expiresIn: NONCE_TTL_SECONDS,
      });
    }
  );

  /**
   * POST /auth/wallet
   * Verifies the wallet signature against the stored nonce and issues a JWT.
   */
  fastify.post(
    '/auth/wallet',
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ) => {
      const parseResult = WalletAuthSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { wallet, signature, nonce } = parseResult.data;
      const normalizedWallet = wallet.toLowerCase();

      // Retrieve stored nonce
      const storedNonce = await redis.get(`${NONCE_PREFIX}${normalizedWallet}`);
      if (!storedNonce) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Nonce not found or expired. Please request a new nonce.',
          statusCode: 401,
        });
      }

      if (storedNonce !== nonce) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Invalid nonce.',
          statusCode: 401,
        });
      }

      // Verify the wallet signature
      try {
        const message = buildSignMessage(normalizedWallet, nonce);
        const recoveredAddress = ethers.verifyMessage(message, signature);
        if (recoveredAddress.toLowerCase() !== normalizedWallet) {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Signature verification failed.',
            statusCode: 401,
          });
        }
      } catch (err) {
        winstonLogger.warn('Signature verification error', {
          wallet: normalizedWallet,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Invalid signature format.',
          statusCode: 401,
        });
      }

      // Consume the nonce (single-use)
      await redis.del(`${NONCE_PREFIX}${normalizedWallet}`);

      // Issue JWT
      const jwtPayload = {
        sub: normalizedWallet,
        wallet: normalizedWallet,
      };
      const accessToken = await (fastify as any).jwt.sign(jwtPayload, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      });

      // Issue refresh token
      const refreshToken = uuidv4();
      await redis.setex(
        `${REFRESH_TOKEN_PREFIX}${refreshToken}`,
        REFRESH_TOKEN_TTL_SECONDS,
        normalizedWallet
      );

      winstonLogger.info('Wallet authenticated', { wallet: normalizedWallet });

      return reply.code(200).send({
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
        wallet: normalizedWallet,
      });
    }
  );

  /**
   * POST /auth/refresh
   * Exchanges a valid refresh token for a new access token.
   */
  fastify.post(
    '/auth/refresh',
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ) => {
      const parseResult = RefreshTokenSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { refreshToken } = parseResult.data;
      const wallet = await redis.get(
        `${REFRESH_TOKEN_PREFIX}${refreshToken}`
      );

      if (!wallet) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Invalid or expired refresh token.',
          statusCode: 401,
        });
      }

      // Rotate the refresh token
      await redis.del(`${REFRESH_TOKEN_PREFIX}${refreshToken}`);
      const newRefreshToken = uuidv4();
      await redis.setex(
        `${REFRESH_TOKEN_PREFIX}${newRefreshToken}`,
        REFRESH_TOKEN_TTL_SECONDS,
        wallet
      );

      const accessToken = await (fastify as any).jwt.sign(
        { sub: wallet, wallet },
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      winstonLogger.info('Token refreshed', { wallet });

      return reply.code(200).send({
        accessToken,
        refreshToken: newRefreshToken,
        tokenType: 'Bearer',
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
        wallet,
      });
    }
  );

  /**
   * GET /auth/me
   * Returns the authenticated user's information from the JWT payload.
   */
  fastify.get(
    '/auth/me',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Not authenticated.',
          statusCode: 401,
        });
      }

      return reply.code(200).send({
        wallet: request.user.wallet,
        sub: request.user.sub,
        issuedAt: new Date(request.user.iat * 1000).toISOString(),
        expiresAt: new Date(request.user.exp * 1000).toISOString(),
      });
    }
  );
}
