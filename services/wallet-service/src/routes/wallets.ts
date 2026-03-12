import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { WalletService } from '../services/wallet.service';

// Validation schemas
const GenerateWalletSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
});

const AgentIdParamSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
});

const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const SignTransactionSchema = z.object({
  agentId: z.string().uuid(),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  value: z.string().regex(/^\d+$/, 'Value must be a numeric string (wei)'),
  data: z.string().regex(/^0x[a-fA-F0-9]*$/, 'Invalid hex data').optional(),
  gasLimit: z.string().regex(/^\d+$/).optional(),
  nonce: z.number().int().min(0).optional(),
});

/**
 * Validates the internal API secret header for privileged endpoints.
 */
function validateInternalSecret(request: FastifyRequest, reply: FastifyReply): boolean {
  const internalSecret = process.env['INTERNAL_API_SECRET'];
  if (!internalSecret) {
    reply.code(500).send({ error: 'Internal server error', message: 'Service misconfigured' });
    return false;
  }

  const providedSecret = request.headers['x-internal-secret'];
  if (!providedSecret || providedSecret !== internalSecret) {
    reply.code(403).send({ error: 'Forbidden', message: 'Invalid internal API secret' });
    return false;
  }

  return true;
}

export async function walletRoutes(
  fastify: FastifyInstance,
  opts: { walletService: WalletService }
): Promise<void> {
  const { walletService } = opts;

  /**
   * POST /wallet/generate
   * Generates a new hot wallet for an AI agent.
   * Returns: { agentId, address, walletId } — NEVER the private key.
   */
  fastify.post(
    '/wallet/generate',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = GenerateWalletSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { agentId } = parseResult.data;

      try {
        const result = await walletService.generateWallet(agentId);
        return reply.code(201).send({
          success: true,
          data: result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to generate wallet';
        if (message.includes('already exists')) {
          return reply.code(409).send({ error: 'Conflict', message });
        }
        fastify.log.error({ err }, 'Failed to generate wallet');
        return reply.code(500).send({ error: 'Internal Server Error', message });
      }
    }
  );

  /**
   * GET /wallet/:agentId
   * Returns wallet info (address + balance) for the given agent.
   */
  fastify.get(
    '/wallet/:agentId',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = AgentIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { agentId } = parseResult.data;

      try {
        const info = await walletService.getWalletInfo(agentId);
        return reply.code(200).send({ success: true, data: info });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch wallet';
        if (message.includes('No wallet found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Failed to fetch wallet info');
        return reply.code(500).send({ error: 'Internal Server Error', message });
      }
    }
  );

  /**
   * GET /wallet/:agentId/balance
   * Returns the current on-chain ETH balance for the agent's wallet.
   */
  fastify.get(
    '/wallet/:agentId/balance',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = AgentIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { agentId } = parseResult.data;

      try {
        const balance = await walletService.getBalance(agentId);
        return reply.code(200).send({
          success: true,
          data: { agentId, balance, unit: 'ETH' },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch balance';
        if (message.includes('No wallet found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Failed to fetch balance');
        return reply.code(500).send({ error: 'Internal Server Error', message });
      }
    }
  );

  /**
   * GET /wallet/:agentId/transactions
   * Returns paginated transaction history for the agent's wallet.
   */
  fastify.get(
    '/wallet/:agentId/transactions',
    async (
      request: FastifyRequest<{ Params: unknown; Querystring: unknown }>,
      reply: FastifyReply
    ) => {
      const paramResult = AgentIdParamSchema.safeParse(request.params);
      if (!paramResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid agentId',
          details: paramResult.error.issues,
        });
      }

      const queryResult = PaginationQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid query params',
          details: queryResult.error.issues,
        });
      }

      const { agentId } = paramResult.data;
      const { page, limit } = queryResult.data;

      try {
        const result = await walletService.getTransactionHistory(agentId, page, limit);
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch transactions';
        if (message.includes('No wallet found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Failed to fetch transactions');
        return reply.code(500).send({ error: 'Internal Server Error', message });
      }
    }
  );

  /**
   * POST /wallet/:agentId/deposit
   * Returns deposit instructions (the wallet address to send funds to).
   */
  fastify.post(
    '/wallet/:agentId/deposit',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = AgentIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { agentId } = parseResult.data;

      try {
        const info = await walletService.getWalletInfo(agentId);
        return reply.code(200).send({
          success: true,
          data: {
            depositAddress: info.address,
            agentId: info.agentId,
            network: process.env['NETWORK_NAME'] ?? 'mainnet',
            instructions:
              'Send ETH or supported ERC-20 tokens to the depositAddress. Funds will be available after 12 block confirmations.',
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to get deposit info';
        if (message.includes('No wallet found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Failed to get deposit info');
        return reply.code(500).send({ error: 'Internal Server Error', message });
      }
    }
  );

  /**
   * POST /wallet/sign — INTERNAL ONLY
   * Signs a transaction for the given agent. Requires x-internal-secret header.
   * NEVER returns the private key. Returns signed transaction bytes and hash.
   */
  fastify.post(
    '/wallet/sign',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      if (!validateInternalSecret(request, reply)) {
        return;
      }

      const parseResult = SignTransactionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { agentId, to, value, data, gasLimit, nonce } = parseResult.data;

      try {
        const result = await walletService.signTransaction(agentId, {
          to,
          value,
          data,
          gasLimit,
          nonce,
        });

        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Signing failed';
        if (message.includes('No wallet found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Transaction signing failed');
        return reply.code(500).send({ error: 'Internal Server Error', message });
      }
    }
  );
}
