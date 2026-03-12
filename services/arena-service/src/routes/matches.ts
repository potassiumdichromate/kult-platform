import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient, MatchStatus } from '@prisma/client';
import Redis from 'ioredis';
import { Logger } from 'winston';
import { z } from 'zod';
import { MatchService } from '../services/match.service';
import { QueueService } from '../services/queue.service';

// ─── Validation schemas ───────────────────────────────────────────────────────

const JoinQueueSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
  eloRating: z.number().int().min(0).max(10_000).default(1200),
  gameMode: z.enum(['deathmatch', 'capture_the_flag', 'battle_royale', 'ranked']).default('deathmatch'),
});

const SubmitResultSchema = z.object({
  winnerId: z.string().uuid('winnerId must be a valid UUID'),
  resultHash: z.string().min(1, 'resultHash is required'),
  telemetry: z.record(z.unknown()).optional(),
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(['PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED'])
    .optional()
    .transform((v) => (v ? (v as MatchStatus) : undefined)),
});

const CancelMatchSchema = z.object({
  reason: z.string().optional(),
});

// ─── Route plugin ─────────────────────────────────────────────────────────────

export async function matchRoutes(
  fastify: FastifyInstance,
  opts: { prisma: PrismaClient; redis: Redis; logger: Logger }
): Promise<void> {
  const { prisma, redis, logger } = opts;
  const matchService = new MatchService(prisma, logger);
  const queueService = new QueueService(redis, logger);

  /**
   * POST /arena/queue
   * Join the matchmaking queue for a specific game mode.
   */
  fastify.post(
    '/arena/queue',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = JoinQueueSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Request body validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { agentId, eloRating, gameMode } = parseResult.data;

      try {
        // Check if agent already has an active match
        const activeMatches = await prisma.match.findFirst({
          where: {
            OR: [{ agent1Id: agentId }, { agent2Id: agentId }],
            status: { in: [MatchStatus.ACTIVE, MatchStatus.PENDING] },
          },
        });

        if (activeMatches) {
          return reply.code(409).send({
            error: 'Conflict',
            message: `Agent ${agentId} already has an active match (${activeMatches.matchId}). Complete or cancel it before queuing.`,
            matchId: activeMatches.matchId,
            statusCode: 409,
          });
        }

        const position = await queueService.joinQueue(agentId, eloRating, gameMode);
        const queueId = `queue-${agentId}-${Date.now()}`;

        return reply.code(202).send({
          queueId,
          agentId,
          gameMode,
          eloRating,
          position: position.position,
          totalInQueue: position.totalInQueue,
          estimatedWaitMs: position.estimatedWaitMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to join queue';
        logger.error('Queue join failed', { agentId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * DELETE /arena/queue/:agentId
   * Leave the matchmaking queue.
   */
  fastify.delete(
    '/arena/queue/:agentId',
    async (
      request: FastifyRequest<{ Params: { agentId: string } }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      const uuidCheck = z.string().uuid().safeParse(agentId);
      if (!uuidCheck.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'agentId must be a valid UUID',
          statusCode: 400,
        });
      }

      try {
        const removed = await queueService.leaveQueue(agentId);

        if (!removed) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Agent ${agentId} is not in any queue`,
            statusCode: 404,
          });
        }

        return reply.code(200).send({
          success: true,
          agentId,
          message: 'Successfully removed from matchmaking queue',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to leave queue';
        logger.error('Queue leave failed', { agentId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /arena/queue/:agentId/status
   * Get an agent's current queue position and wait time.
   */
  fastify.get(
    '/arena/queue/:agentId/status',
    async (
      request: FastifyRequest<{ Params: { agentId: string } }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      try {
        const inQueue = await queueService.isInQueue(agentId);
        if (!inQueue) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Agent ${agentId} is not in any queue`,
            statusCode: 404,
          });
        }

        const position = await queueService.getQueuePosition(agentId);
        return reply.code(200).send({ agentId, ...position });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /arena/matches/active
   * List all currently active matches.
   * NOTE: This route must be registered BEFORE /arena/matches/:matchId to avoid param clash.
   */
  fastify.get(
    '/arena/matches/active',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const matches = await matchService.getActiveMatches();
        return reply.code(200).send({ matches, total: matches.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Error fetching active matches', { error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /arena/matches/:matchId
   * Get a specific match by its ID.
   */
  fastify.get(
    '/arena/matches/:matchId',
    async (
      request: FastifyRequest<{ Params: { matchId: string } }>,
      reply: FastifyReply
    ) => {
      const { matchId } = request.params;

      const uuidCheck = z.string().uuid().safeParse(matchId);
      if (!uuidCheck.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'matchId must be a valid UUID',
          statusCode: 400,
        });
      }

      try {
        const match = await matchService.getMatchById(matchId);
        if (!match) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Match ${matchId} not found`,
            statusCode: 404,
          });
        }
        return reply.code(200).send({ match });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Error fetching match', { matchId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /arena/matches/agent/:agentId
   * Get match history for an agent with pagination.
   */
  fastify.get(
    '/arena/matches/agent/:agentId',
    async (
      request: FastifyRequest<{ Params: { agentId: string }; Querystring: unknown }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      const pageResult = PaginationSchema.safeParse(request.query);
      if (!pageResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid query parameters',
          details: pageResult.error.issues,
          statusCode: 400,
        });
      }

      const { page, limit, status } = pageResult.data;

      try {
        const result = await matchService.getMatchHistory(agentId, page, limit, status);
        return reply.code(200).send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Error fetching match history', { agentId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * POST /arena/matches/:matchId/result
   * Submit the result of a match (internal endpoint, called by game engine).
   */
  fastify.post(
    '/arena/matches/:matchId/result',
    async (
      request: FastifyRequest<{
        Params: { matchId: string };
        Body: unknown;
      }>,
      reply: FastifyReply
    ) => {
      const { matchId } = request.params;

      const uuidCheck = z.string().uuid().safeParse(matchId);
      if (!uuidCheck.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'matchId must be a valid UUID',
          statusCode: 400,
        });
      }

      const parseResult = SubmitResultSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Request body validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      try {
        const match = await matchService.submitResult(matchId, parseResult.data);
        return reply.code(200).send({
          success: true,
          match,
          message: 'Match result recorded successfully',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to submit result';

        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message, statusCode: 404 });
        }
        if (message.includes('already completed') || message.includes('cancelled')) {
          return reply.code(409).send({ error: 'Conflict', message, statusCode: 409 });
        }
        if (message.includes('not a participant')) {
          return reply.code(422).send({
            error: 'Unprocessable Entity',
            message,
            statusCode: 422,
          });
        }

        logger.error('Error submitting match result', { matchId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * POST /arena/matches/:matchId/cancel
   * Cancel a match.
   */
  fastify.post(
    '/arena/matches/:matchId/cancel',
    async (
      request: FastifyRequest<{
        Params: { matchId: string };
        Body: unknown;
      }>,
      reply: FastifyReply
    ) => {
      const { matchId } = request.params;

      const uuidCheck = z.string().uuid().safeParse(matchId);
      if (!uuidCheck.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'matchId must be a valid UUID',
          statusCode: 400,
        });
      }

      const bodyResult = CancelMatchSchema.safeParse(request.body);

      try {
        const match = await matchService.cancelMatch(
          matchId,
          bodyResult.success ? bodyResult.data.reason : undefined
        );
        return reply.code(200).send({
          success: true,
          match,
          message: 'Match cancelled',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to cancel match';

        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message, statusCode: 404 });
        }
        if (message.includes('already completed')) {
          return reply.code(409).send({ error: 'Conflict', message, statusCode: 409 });
        }

        logger.error('Error cancelling match', { matchId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );
}
