import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { TelemetryService } from '../services/telemetry.service';
import { EventType } from '../models/telemetry.model';

const EVENT_TYPES: EventType[] = [
  'MOVE',
  'SHOOT',
  'DEATH',
  'KILL',
  'PICKUP',
  'ABILITY',
  'ROUND_START',
  'ROUND_END',
  'MATCH_END',
];

const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const TelemetryEventInputSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
  matchId: z.string().uuid('matchId must be a valid UUID'),
  eventType: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
  position: PositionSchema.optional(),
  payload: z.record(z.unknown()).optional(),
  timestamp: z
    .string()
    .datetime()
    .optional()
    .transform((v) => (v ? new Date(v) : new Date())),
});

const BatchInsertSchema = z.object({
  events: z
    .array(TelemetryEventInputSchema)
    .min(1, 'At least 1 event required')
    .max(100, 'Maximum 100 events per batch'),
});

const MatchIdParamSchema = z.object({
  matchId: z.string().uuid('matchId must be a valid UUID'),
});

const AgentIdParamSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
});

const ReplayParamSchema = z.object({
  agentId: z.string().uuid(),
  matchId: z.string().uuid(),
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export async function telemetryRoutes(
  fastify: FastifyInstance,
  opts: { telemetryService: TelemetryService }
): Promise<void> {
  const { telemetryService } = opts;

  /**
   * POST /telemetry/events
   * Batch insert up to 100 telemetry events.
   */
  fastify.post(
    '/telemetry/events',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = BatchInsertSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Validation failed',
          details: parseResult.error.issues,
        });
      }

      const { events } = parseResult.data;

      try {
        const result = await telemetryService.batchInsertEvents(events);
        const statusCode = result.failed === 0 ? 201 : 207; // 207 Multi-Status if partial failure

        return reply.code(statusCode).send({
          success: result.failed === 0,
          data: result,
        });
      } catch (err) {
        fastify.log.error({ err }, 'Batch insert failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : 'Batch insert failed',
        });
      }
    }
  );

  /**
   * GET /telemetry/match/:matchId
   * Returns all events for a match in chronological order.
   */
  fastify.get(
    '/telemetry/match/:matchId',
    async (
      request: FastifyRequest<{ Params: unknown; Querystring: unknown }>,
      reply: FastifyReply
    ) => {
      const paramResult = MatchIdParamSchema.safeParse(request.params);
      if (!paramResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid matchId',
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

      const { matchId } = paramResult.data;
      const { page, limit } = queryResult.data;

      try {
        const result = await telemetryService.getMatchEventsPaginated(matchId, page, limit);
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch match events');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /telemetry/agent/:agentId/stats
   * Returns aggregated gameplay statistics for an agent.
   */
  fastify.get(
    '/telemetry/agent/:agentId/stats',
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
        const stats = await telemetryService.getAgentStats(agentId);
        return reply.code(200).send({ success: true, data: stats });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to aggregate agent stats');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  /**
   * GET /telemetry/agent/:agentId/replay/:matchId
   * Returns full match replay data for a specific agent in a specific match.
   */
  fastify.get(
    '/telemetry/agent/:agentId/replay/:matchId',
    async (request: FastifyRequest<{ Params: unknown }>, reply: FastifyReply) => {
      const parseResult = ReplayParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid path parameters',
          details: parseResult.error.issues,
        });
      }

      const { agentId, matchId } = parseResult.data;

      try {
        const replay = await telemetryService.getMatchReplay(agentId, matchId);

        if (replay.eventCount === 0) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `No replay data found for agent ${agentId} in match ${matchId}`,
          });
        }

        return reply.code(200).send({ success: true, data: replay });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch replay data');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );
}
