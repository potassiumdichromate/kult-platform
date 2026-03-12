import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RankingService } from '../services/ranking.service';

const UpdateELOSchema = z.object({
  matchId: z.string().uuid('matchId must be a valid UUID'),
  winnerId: z.string().uuid('winnerId must be a valid UUID'),
  loserId: z.string().uuid('loserId must be a valid UUID'),
  winnerElo: z.number().int().min(100).optional(),
  loserElo: z.number().int().min(100).optional(),
});

const AgentIdParamSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
});

const LeaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function requireInternalKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const internalSecret = process.env['INTERNAL_API_SECRET'];
  if (!internalSecret) {
    reply.code(503).send({ error: 'Service Unavailable', message: 'Internal operations not configured' });
    return false;
  }
  const provided = request.headers['x-internal-secret'];
  if (provided !== internalSecret) {
    reply.code(403).send({ error: 'Forbidden', message: 'Invalid internal secret' });
    return false;
  }
  return true;
}

export async function rankingRoutes(
  fastify: FastifyInstance,
  opts: { rankingService: RankingService }
): Promise<void> {
  const { rankingService } = opts;

  /**
   * POST /ranking/update
   * Internal endpoint — updates ELO ratings after a match.
   * Requires x-internal-secret header.
   */
  fastify.post(
    '/ranking/update',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      if (!requireInternalKey(request, reply)) return;

      const parseResult = UpdateELOSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { matchId, winnerId, loserId, winnerElo, loserElo } = parseResult.data;

      try {
        const result = await rankingService.updateELOAfterMatch(
          matchId,
          winnerId,
          loserId,
          winnerElo,
          loserElo
        );
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to update ELO');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : 'ELO update failed',
        });
      }
    }
  );

  /**
   * GET /ranking/leaderboard
   * Returns the global ELO leaderboard, cached for 60s.
   */
  fastify.get(
    '/ranking/leaderboard',
    async (request: FastifyRequest<{ Querystring: unknown }>, reply: FastifyReply) => {
      const parseResult = LeaderboardQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid query params',
          details: parseResult.error.issues,
        });
      }

      const { limit, offset } = parseResult.data;

      try {
        const leaderboard = await rankingService.getLeaderboard(limit, offset);
        return reply.code(200).send({
          success: true,
          data: {
            entries: leaderboard,
            limit,
            offset,
            count: leaderboard.length,
          },
        });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch leaderboard');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /ranking/agent/:agentId
   * Returns rank info and stats for a specific agent.
   */
  fastify.get(
    '/ranking/agent/:agentId',
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
        const rank = await rankingService.getAgentRank(agentId);
        return reply.code(200).send({ success: true, data: rank });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch agent rank');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /ranking/agent/:agentId/history
   * Returns paginated ELO change history for an agent.
   */
  fastify.get(
    '/ranking/agent/:agentId/history',
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
        const result = await rankingService.getAgentRankHistory(agentId, page, limit);
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch rank history');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );
}
