import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { TransactionService } from '../services/transaction.service';

const RequestTransactionSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
  type: z.enum(['BUY_WEAPON', 'UPGRADE_WEAPON', 'TREASURY_DEPOSIT']),
  weaponId: z.string().optional(),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'Amount must be a positive decimal number (ETH)'),
});

const TxIdParamSchema = z.object({
  txId: z.string().uuid('txId must be a valid UUID'),
});

const AgentIdParamSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function requireAdminKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const adminKey = process.env['ADMIN_API_KEY'];
  if (!adminKey) {
    reply.code(503).send({ error: 'Service Unavailable', message: 'Admin operations not configured' });
    return false;
  }
  const provided = request.headers['x-admin-key'];
  if (provided !== adminKey) {
    reply.code(403).send({ error: 'Forbidden', message: 'Invalid admin key' });
    return false;
  }
  return true;
}

export async function transactionRoutes(
  fastify: FastifyInstance,
  opts: { transactionService: TransactionService }
): Promise<void> {
  const { transactionService } = opts;

  /**
   * POST /transactions/request
   * AI agent submits a transaction request through the policy engine.
   */
  fastify.post(
    '/transactions/request',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = RequestTransactionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { agentId, type, weaponId, amount } = parseResult.data;

      try {
        const result = await transactionService.requestTransaction({
          agentId,
          type,
          weaponId,
          amount,
        });

        const statusCode = result.policyResult.approved ? 202 : 422;
        return reply.code(statusCode).send({
          success: result.policyResult.approved,
          data: result,
        });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to process transaction request');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * GET /transactions/:txId
   * Returns the current status of a transaction.
   */
  fastify.get(
    '/transactions/:txId',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = TxIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid txId',
          details: parseResult.error.issues,
        });
      }

      const { txId } = parseResult.data;

      try {
        const tx = await transactionService.getTransaction(txId);
        if (!tx) {
          return reply.code(404).send({ error: 'Not Found', message: `Transaction ${txId} not found` });
        }
        return reply.code(200).send({ success: true, data: tx });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch transaction');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /transactions/agent/:agentId
   * Returns paginated transaction history for an agent.
   */
  fastify.get(
    '/transactions/agent/:agentId',
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

      const queryResult = PaginationSchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid pagination params',
          details: queryResult.error.issues,
        });
      }

      const { agentId } = paramResult.data;
      const { page, limit } = queryResult.data;

      try {
        const result = await transactionService.getAgentTransactions(agentId, page, limit);
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch agent transactions');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /transactions/agent/:agentId/spending
   * Returns today's spending stats for an agent.
   */
  fastify.get(
    '/transactions/agent/:agentId/spending',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = AgentIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid agentId',
          details: parseResult.error.issues,
        });
      }

      const { agentId } = parseResult.data;

      try {
        const stats = await transactionService.getSpendingStats(agentId);
        return reply.code(200).send({ success: true, data: stats });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch spending stats');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * POST /transactions/:txId/retry
   * Retries a failed transaction. Admin only.
   */
  fastify.post(
    '/transactions/:txId/retry',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const parseResult = TxIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid txId',
          details: parseResult.error.issues,
        });
      }

      const { txId } = parseResult.data;

      try {
        await transactionService.retryTransaction(txId);
        return reply.code(200).send({
          success: true,
          message: `Transaction ${txId} queued for retry`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        if (message.includes('cannot be retried')) {
          return reply.code(409).send({ error: 'Conflict', message });
        }
        fastify.log.error({ err }, 'Failed to retry transaction');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );
}
