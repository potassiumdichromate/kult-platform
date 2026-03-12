import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { TournamentService } from '../services/tournament.service';
import { TournamentStatus } from '@prisma/client';

const CreateTournamentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  prizePool: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'prizePool must be a decimal ETH value'),
  entryFee: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'entryFee must be a decimal ETH value')
    .optional(),
  maxParticipants: z
    .number()
    .int()
    .min(2)
    .refine(
      (n) => n > 0 && (n & (n - 1)) === 0,
      'maxParticipants must be a power of 2 (2, 4, 8, 16, 32, 64...)'
    ),
  startTime: z.string().datetime(),
});

const JoinTournamentSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
});

const MatchResultSchema = z.object({
  matchId: z.string().uuid('matchId must be a valid UUID'),
  winnerId: z.string().uuid('winnerId must be a valid UUID'),
});

const TournamentIdParamSchema = z.object({
  tournamentId: z.string().uuid('tournamentId must be a valid UUID'),
});

const ListQuerySchema = z.object({
  status: z.enum(['REGISTRATION', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
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

export async function tournamentRoutes(
  fastify: FastifyInstance,
  opts: { tournamentService: TournamentService }
): Promise<void> {
  const { tournamentService } = opts;

  /**
   * POST /tournaments
   * Creates a new tournament. Admin only.
   */
  fastify.post(
    '/tournaments',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const parseResult = CreateTournamentSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { name, description, prizePool, entryFee, maxParticipants, startTime } =
        parseResult.data;

      try {
        const tournament = await tournamentService.createTournament({
          name,
          description,
          prizePool,
          entryFee,
          maxParticipants,
          startTime: new Date(startTime),
        });
        return reply.code(201).send({ success: true, data: tournament });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create tournament';
        return reply.code(400).send({ error: 'Bad Request', message });
      }
    }
  );

  /**
   * GET /tournaments
   * Lists tournaments with optional status filter and pagination.
   */
  fastify.get(
    '/tournaments',
    async (request: FastifyRequest<{ Querystring: unknown }>, reply: FastifyReply) => {
      const parseResult = ListQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid query params',
          details: parseResult.error.issues,
        });
      }

      const { status, page, limit } = parseResult.data;

      try {
        const result = await tournamentService.listTournaments(
          status as TournamentStatus | undefined,
          page,
          limit
        );
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to list tournaments');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /tournaments/:tournamentId
   * Returns tournament details including all participants.
   */
  fastify.get(
    '/tournaments/:tournamentId',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = TournamentIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid tournamentId',
          details: parseResult.error.issues,
        });
      }

      const { tournamentId } = parseResult.data;

      try {
        const tournament = await tournamentService.getTournament(tournamentId);
        return reply.code(200).send({ success: true, data: tournament });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Not found';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Failed to get tournament');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * POST /tournaments/:tournamentId/join
   * Registers an AI agent for a tournament.
   */
  fastify.post(
    '/tournaments/:tournamentId/join',
    async (
      request: FastifyRequest<{ Params: unknown; Body: unknown }>,
      reply: FastifyReply
    ) => {
      const paramResult = TournamentIdParamSchema.safeParse(request.params);
      if (!paramResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid tournamentId',
          details: paramResult.error.issues,
        });
      }

      const bodyResult = JoinTournamentSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: bodyResult.error.issues,
        });
      }

      const { tournamentId } = paramResult.data;
      const { agentId } = bodyResult.data;

      try {
        const participant = await tournamentService.joinTournament(tournamentId, agentId);
        return reply.code(201).send({ success: true, data: participant });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to join tournament';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        if (
          message.includes('already registered') ||
          message.includes('full') ||
          message.includes('closed')
        ) {
          return reply.code(409).send({ error: 'Conflict', message });
        }
        fastify.log.error({ err }, 'Failed to join tournament');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * POST /tournaments/:tournamentId/start
   * Starts a tournament and generates brackets. Admin only.
   */
  fastify.post(
    '/tournaments/:tournamentId/start',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const parseResult = TournamentIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid tournamentId',
          details: parseResult.error.issues,
        });
      }

      const { tournamentId } = parseResult.data;

      try {
        const bracket = await tournamentService.startTournament(tournamentId);
        return reply.code(200).send({ success: true, data: bracket });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to start tournament';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        if (message.includes('already') || message.includes('least 2')) {
          return reply.code(409).send({ error: 'Conflict', message });
        }
        fastify.log.error({ err }, 'Failed to start tournament');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /tournaments/:tournamentId/bracket
   * Returns the current bracket state.
   */
  fastify.get(
    '/tournaments/:tournamentId/bracket',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = TournamentIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid tournamentId',
          details: parseResult.error.issues,
        });
      }

      const { tournamentId } = parseResult.data;

      try {
        const bracket = await tournamentService.getBracket(tournamentId);
        return reply.code(200).send({ success: true, data: bracket });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch bracket';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Failed to fetch bracket');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * POST /tournaments/:tournamentId/match-result
   * Reports a match result and advances the bracket.
   */
  fastify.post(
    '/tournaments/:tournamentId/match-result',
    async (
      request: FastifyRequest<{ Params: unknown; Body: unknown }>,
      reply: FastifyReply
    ) => {
      const paramResult = TournamentIdParamSchema.safeParse(request.params);
      if (!paramResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid tournamentId',
          details: paramResult.error.issues,
        });
      }

      const bodyResult = MatchResultSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: bodyResult.error.issues,
        });
      }

      const { tournamentId } = paramResult.data;
      const { matchId, winnerId } = bodyResult.data;

      try {
        const result = await tournamentService.advanceBracket(tournamentId, matchId, winnerId);
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to advance bracket';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        if (message.includes('already has a winner') || message.includes('not in progress')) {
          return reply.code(409).send({ error: 'Conflict', message });
        }
        fastify.log.error({ err }, 'Failed to advance bracket');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /tournaments/:tournamentId/leaderboard
   * Returns current standings for a tournament.
   */
  fastify.get(
    '/tournaments/:tournamentId/leaderboard',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = TournamentIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid tournamentId',
          details: parseResult.error.issues,
        });
      }

      const { tournamentId } = parseResult.data;

      try {
        const leaderboard = await tournamentService.getLeaderboard(tournamentId);
        return reply.code(200).send({ success: true, data: leaderboard });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Not found';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Failed to fetch leaderboard');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );
}
