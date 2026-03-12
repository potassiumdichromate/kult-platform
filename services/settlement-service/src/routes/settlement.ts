import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SettlementService } from '../services/settlement.service';

const SettleMatchSchema = z.object({
  matchId: z.string().uuid('matchId must be a valid UUID'),
  winnerId: z.string().uuid('winnerId must be a valid UUID'),
  loserId: z.string().uuid('loserId must be a valid UUID'),
  rounds: z.number().int().min(1),
  winnerKills: z.number().int().min(0),
  loserKills: z.number().int().min(0),
  duration: z.number().int().min(0),
  timestamp: z.number().int(),
});

const SettleTournamentSchema = z.object({
  tournamentId: z.string().uuid('tournamentId must be a valid UUID'),
  brackets: z.array(
    z.object({
      round: z.number().int().min(1),
      matchId: z.string().uuid(),
      winnerId: z.string().uuid(),
      loserId: z.string().uuid(),
    })
  ).min(1),
  payouts: z.array(
    z.object({
      agentId: z.string().uuid(),
      placement: z.number().int().min(1),
      amountEth: z.string().regex(/^\d+(\.\d+)?$/),
    })
  ).min(1),
});

const SettlementIdParamSchema = z.object({
  settlementId: z.string().uuid('settlementId must be a valid UUID'),
});

export async function settlementRoutes(
  fastify: FastifyInstance,
  opts: { settlementService: SettlementService }
): Promise<void> {
  const { settlementService } = opts;

  /**
   * POST /settlement/match
   * Settle a match result on-chain.
   */
  fastify.post(
    '/settlement/match',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = SettleMatchSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { matchId, winnerId, loserId, rounds, winnerKills, loserKills, duration, timestamp } =
        parseResult.data;

      try {
        const result = await settlementService.settleMatch(matchId, winnerId, {
          matchId,
          winnerId,
          loserId,
          rounds,
          winnerKills,
          loserKills,
          duration,
          timestamp,
        });

        return reply.code(201).send({ success: true, data: result });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to settle match');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : 'Settlement failed',
        });
      }
    }
  );

  /**
   * POST /settlement/tournament
   * Settle a tournament result on-chain using a Merkle root.
   */
  fastify.post(
    '/settlement/tournament',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = SettleTournamentSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { tournamentId, brackets, payouts } = parseResult.data;

      try {
        const result = await settlementService.settleTournament(tournamentId, brackets, payouts);
        return reply.code(201).send({ success: true, data: result });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to settle tournament');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : 'Settlement failed',
        });
      }
    }
  );

  /**
   * GET /settlement/:settlementId
   * Returns the settlement record and current status.
   */
  fastify.get(
    '/settlement/:settlementId',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = SettlementIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid settlementId',
          details: parseResult.error.issues,
        });
      }

      const { settlementId } = parseResult.data;

      try {
        const settlement = await settlementService.getSettlement(settlementId);
        if (!settlement) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Settlement ${settlementId} not found`,
          });
        }
        return reply.code(200).send({ success: true, data: settlement });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch settlement');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * POST /settlement/verify/:settlementId
   * Reads the blockchain to verify and update the settlement status.
   */
  fastify.post(
    '/settlement/verify/:settlementId',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = SettlementIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid settlementId',
          details: parseResult.error.issues,
        });
      }

      const { settlementId } = parseResult.data;

      try {
        const settlement = await settlementService.verifySettlement(settlementId);
        return reply.code(200).send({ success: true, data: settlement });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Verification failed';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        fastify.log.error({ err }, 'Settlement verification failed');
        return reply.code(500).send({ error: 'Internal Server Error', message });
      }
    }
  );
}
