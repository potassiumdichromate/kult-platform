import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AgentStatus } from '@prisma/client';
import { z } from 'zod';
import { AgentService } from '../services/agent.service';
import { winstonLogger } from '../logger';

// ── Validation Schemas ─────────────────────────────────────────────────────

const WalletAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum wallet address');

const CreateAgentSchema = z.object({
  ownerWallet: WalletAddressSchema,
  hotWalletAddress: WalletAddressSchema.optional(),
  modelHash: z.string().min(1).max(256).optional(),
});

const UpdateStatusSchema = z.object({
  status: z.nativeEnum(AgentStatus),
});

const UpdateModelSchema = z.object({
  modelHash: z
    .string()
    .min(1, 'Model hash is required')
    .max(256, 'Model hash too long'),
});

const UpdateEloSchema = z.object({
  newRating: z
    .number()
    .int('ELO rating must be an integer')
    .min(0, 'ELO rating cannot be negative')
    .max(10000, 'ELO rating too high'),
  change: z.number().int('ELO change must be an integer'),
  reason: z.string().max(500).optional(),
});

const UpdateHotWalletSchema = z.object({
  hotWalletAddress: WalletAddressSchema,
});

const LeaderboardQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 100))
    .pipe(z.number().int().min(1).max(100)),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 0))
    .pipe(z.number().int().min(0)),
});

// ── Route Params ───────────────────────────────────────────────────────────

interface AgentParams {
  agentId: string;
}

interface OwnerParams {
  wallet: string;
}

// ── Helper: verify internal API secret ────────────────────────────────────

function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  const secret = request.headers['x-internal-api-secret'];
  const expectedSecret = process.env.INTERNAL_API_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    reply.code(403).send({
      error: 'Forbidden',
      message: 'This endpoint requires a valid internal API secret.',
      statusCode: 403,
    });
    return false;
  }
  return true;
}

// ── Route Registration ─────────────────────────────────────────────────────

export async function agentRoutes(
  fastify: FastifyInstance,
  opts: { agentService: AgentService }
): Promise<void> {
  const { agentService } = opts;

  /**
   * GET /agents/leaderboard
   * Returns the top agents by ELO (cached 30s). Public endpoint.
   */
  fastify.get(
    '/leaderboard',
    async (
      request: FastifyRequest<{ Querystring: Record<string, string> }>,
      reply: FastifyReply
    ) => {
      const parseResult = LeaderboardQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid query parameters',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { limit, offset } = parseResult.data;

      try {
        const leaderboard = await agentService.getLeaderboard(limit, offset);
        return reply.code(200).send({
          data: leaderboard,
          meta: { limit, offset, count: leaderboard.length },
        });
      } catch (err) {
        winstonLogger.error('Failed to fetch leaderboard', {
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve leaderboard.',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * POST /agents
   * Registers a new agent. Requires authenticated user (wallet in JWT).
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ) => {
      const parseResult = CreateAgentSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const data = parseResult.data;

      // Verify the requester is the owner (from JWT forwarded by gateway)
      const requesterWallet = (
        request.headers['x-user-wallet'] as string | undefined
      )?.toLowerCase();

      if (requesterWallet && requesterWallet !== data.ownerWallet.toLowerCase()) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'You can only register agents for your own wallet.',
          statusCode: 403,
        });
      }

      try {
        const agent = await agentService.createAgent(data);
        return reply.code(201).send({
          data: agent,
          message: 'Agent registered successfully.',
        });
      } catch (err) {
        winstonLogger.error('Failed to create agent', {
          error: err instanceof Error ? err.message : 'Unknown error',
          data,
        });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message:
            err instanceof Error ? err.message : 'Failed to create agent.',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * GET /agents/:agentId
   * Returns a single agent by ID (Redis-cached 60s).
   */
  fastify.get(
    '/:agentId',
    async (
      request: FastifyRequest<{ Params: AgentParams }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      if (!agentId || agentId.trim() === '') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'agentId is required.',
          statusCode: 400,
        });
      }

      try {
        const agent = await agentService.getAgent(agentId);
        if (!agent) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Agent with ID '${agentId}' was not found.`,
            statusCode: 404,
          });
        }
        return reply.code(200).send({ data: agent });
      } catch (err) {
        winstonLogger.error('Failed to fetch agent', {
          agentId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve agent.',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * GET /agents/owner/:wallet
   * Returns all agents for a given owner wallet address.
   */
  fastify.get(
    '/owner/:wallet',
    async (
      request: FastifyRequest<{ Params: OwnerParams }>,
      reply: FastifyReply
    ) => {
      const { wallet } = request.params;

      const walletParse = WalletAddressSchema.safeParse(wallet);
      if (!walletParse.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid wallet address format.',
          statusCode: 400,
        });
      }

      try {
        const agents = await agentService.getAgentsByOwner(wallet);
        return reply.code(200).send({
          data: agents,
          meta: { count: agents.length, wallet: wallet.toLowerCase() },
        });
      } catch (err) {
        winstonLogger.error('Failed to fetch agents by owner', {
          wallet,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve agents.',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * PATCH /agents/:agentId/status
   * Updates agent status. Must be the owner or have internal secret.
   */
  fastify.patch(
    '/:agentId/status',
    async (
      request: FastifyRequest<{ Params: AgentParams; Body: unknown }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      const parseResult = UpdateStatusSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { status } = parseResult.data;

      // Verify ownership
      const requesterWallet = (
        request.headers['x-user-wallet'] as string | undefined
      )?.toLowerCase();
      const hasInternalSecret =
        request.headers['x-internal-api-secret'] === process.env.INTERNAL_API_SECRET;

      if (!hasInternalSecret && requesterWallet) {
        const agent = await agentService.getAgent(agentId);
        if (!agent) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Agent '${agentId}' not found.`,
            statusCode: 404,
          });
        }
        if (agent.ownerWallet !== requesterWallet) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not own this agent.',
            statusCode: 403,
          });
        }
      }

      try {
        const agent = await agentService.updateStatus(agentId, status);
        return reply.code(200).send({
          data: agent,
          message: `Agent status updated to ${status}.`,
        });
      } catch (err) {
        winstonLogger.error('Failed to update agent status', {
          agentId,
          status,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to update agent status.',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * PATCH /agents/:agentId/model
   * Updates the model hash for an agent.
   */
  fastify.patch(
    '/:agentId/model',
    async (
      request: FastifyRequest<{ Params: AgentParams; Body: unknown }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      const parseResult = UpdateModelSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { modelHash } = parseResult.data;

      // Verify ownership
      const requesterWallet = (
        request.headers['x-user-wallet'] as string | undefined
      )?.toLowerCase();

      if (requesterWallet) {
        const agent = await agentService.getAgent(agentId);
        if (!agent) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Agent '${agentId}' not found.`,
            statusCode: 404,
          });
        }
        if (agent.ownerWallet !== requesterWallet) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not own this agent.',
            statusCode: 403,
          });
        }
      }

      try {
        const agent = await agentService.updateModelHash(agentId, modelHash);
        return reply.code(200).send({
          data: agent,
          message: 'Agent model hash updated.',
        });
      } catch (err) {
        winstonLogger.error('Failed to update model hash', {
          agentId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to update model hash.',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * PATCH /agents/:agentId/elo
   * Updates ELO rating. Internal only — requires INTERNAL_API_SECRET header.
   */
  fastify.patch(
    '/:agentId/elo',
    async (
      request: FastifyRequest<{ Params: AgentParams; Body: unknown }>,
      reply: FastifyReply
    ) => {
      if (!requireInternalSecret(request, reply)) return;

      const { agentId } = request.params;

      const parseResult = UpdateEloSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { newRating, change, reason } = parseResult.data;

      try {
        const agent = await agentService.updateELO({
          agentId,
          newRating,
          change,
          reason,
        });
        return reply.code(200).send({
          data: agent,
          message: 'Agent ELO updated.',
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        const isNotFound = message.includes('not found');
        winstonLogger.error('Failed to update ELO', {
          agentId,
          error: message,
        });
        return reply.code(isNotFound ? 404 : 500).send({
          error: isNotFound ? 'Not Found' : 'Internal Server Error',
          message: isNotFound ? message : 'Failed to update ELO.',
          statusCode: isNotFound ? 404 : 500,
        });
      }
    }
  );

  /**
   * PATCH /agents/:agentId/hot-wallet
   * Updates the hot wallet for an agent. Must be the owner.
   */
  fastify.patch(
    '/:agentId/hot-wallet',
    async (
      request: FastifyRequest<{ Params: AgentParams; Body: unknown }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      const parseResult = UpdateHotWalletSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { hotWalletAddress } = parseResult.data;
      const requesterWallet = (
        request.headers['x-user-wallet'] as string | undefined
      )?.toLowerCase();

      if (requesterWallet) {
        const agent = await agentService.getAgent(agentId);
        if (!agent) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Agent '${agentId}' not found.`,
            statusCode: 404,
          });
        }
        if (agent.ownerWallet !== requesterWallet) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not own this agent.',
            statusCode: 403,
          });
        }
      }

      try {
        const agent = await agentService.updateHotWallet(agentId, hotWalletAddress);
        return reply.code(200).send({
          data: agent,
          message: 'Hot wallet updated.',
        });
      } catch (err) {
        winstonLogger.error('Failed to update hot wallet', {
          agentId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message:
            err instanceof Error ? err.message : 'Failed to update hot wallet.',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * DELETE /agents/:agentId
   * Soft-deletes (deactivates) an agent. Must be the owner.
   */
  fastify.delete(
    '/:agentId',
    async (
      request: FastifyRequest<{ Params: AgentParams }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;
      const requesterWallet = (
        request.headers['x-user-wallet'] as string | undefined
      )?.toLowerCase();

      if (requesterWallet) {
        const agent = await agentService.getAgent(agentId);
        if (!agent) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Agent '${agentId}' not found.`,
            statusCode: 404,
          });
        }
        if (agent.ownerWallet !== requesterWallet) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not own this agent.',
            statusCode: 403,
          });
        }
      }

      try {
        const agent = await agentService.deactivateAgent(agentId);
        return reply.code(200).send({
          data: agent,
          message: 'Agent deactivated successfully.',
        });
      } catch (err) {
        winstonLogger.error('Failed to deactivate agent', {
          agentId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to deactivate agent.',
          statusCode: 500,
        });
      }
    }
  );
}
