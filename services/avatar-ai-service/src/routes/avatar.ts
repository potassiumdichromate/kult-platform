import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { Logger } from 'winston';
import { z } from 'zod';
import { WarzoneClient } from '../integrations/warzone.client';
import { BehaviorService } from '../services/behavior.service';
import { TrainingJobData, createTrainingQueue } from '../workers/training.worker';

// ─── Validation schemas ───────────────────────────────────────────────────────

const GameActionSchema = z.object({
  actionType: z.string().min(1),
  timestamp: z.number(),
  position: z
    .object({ x: z.number(), y: z.number(), z: z.number().optional() })
    .optional(),
  targetPosition: z
    .object({ x: z.number(), y: z.number(), z: z.number().optional() })
    .optional(),
  rotation: z.number().optional(),
  velocity: z
    .object({ x: z.number(), y: z.number(), z: z.number().optional() })
    .optional(),
  weapon: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const RecordBehaviorSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
  matchId: z.string().min(1, 'matchId is required'),
  actionSequence: z.array(GameActionSchema).min(1, 'actionSequence must not be empty'),
  gameState: z.record(z.unknown()),
});

const TriggerTrainingSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
  epochs: z.number().int().min(1).max(500).optional(),
  learningRate: z.number().min(0.00001).max(1.0).optional(),
  batchSize: z.number().int().min(1).max(512).optional(),
});

const PredictSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
  gameState: z.record(z.unknown()),
  topK: z.number().int().min(1).max(20).optional().default(5),
});

// ─── Route plugin ─────────────────────────────────────────────────────────────

export async function avatarRoutes(
  fastify: FastifyInstance,
  opts: { redis: Redis; logger: Logger }
): Promise<void> {
  const { redis, logger } = opts;

  const warzoneClient = new WarzoneClient(logger);
  const behaviorService = new BehaviorService(warzoneClient, redis, logger);
  const trainingQueue: Queue<TrainingJobData> = createTrainingQueue(redis);

  /**
   * POST /avatar/behavior
   * Record behavioral data for an agent. Enqueues a buffered write to Warzone.
   */
  fastify.post(
    '/avatar/behavior',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = RecordBehaviorSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Request body validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { agentId, matchId, actionSequence, gameState } = parseResult.data;

      try {
        const result = await behaviorService.batchBehaviorData(
          agentId,
          matchId,
          actionSequence,
          gameState
        );

        // Generate a tracking job ID for this behavior record
        const jobId = `behavior-${agentId}-${Date.now()}`;

        logger.info('Behavior data recorded', {
          agentId,
          matchId,
          actionCount: actionSequence.length,
          bufferedCount: result.bufferedCount,
          flushed: result.flushed,
        });

        return reply.code(202).send({
          jobId,
          status: 'queued',
          bufferedCount: result.bufferedCount,
          flushed: result.flushed,
          recordId: result.recordId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to record behavior data';
        logger.error('Behavior recording failed', { agentId, error: message });

        if (message.includes('circuit breaker')) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'AI Warzone service is temporarily unavailable',
            statusCode: 503,
          });
        }

        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * POST /avatar/train
   * Trigger async model training for an agent. Returns job details.
   */
  fastify.post(
    '/avatar/train',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = TriggerTrainingSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Request body validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { agentId, epochs, learningRate, batchSize } = parseResult.data;

      try {
        // Check if there's already a training job queued/running for this agent
        const waitingJobs = await trainingQueue.getWaiting();
        const activeJobs = await trainingQueue.getActive();

        const alreadyQueued = [...waitingJobs, ...activeJobs].some(
          (j) => j.data.agentId === agentId
        );

        if (alreadyQueued) {
          return reply.code(409).send({
            error: 'Conflict',
            message: `A training job is already queued or running for agent ${agentId}`,
            statusCode: 409,
          });
        }

        // Flush any buffered behavior data before training
        try {
          await behaviorService.flushBuffer(agentId);
        } catch (err) {
          logger.warn('Could not flush buffer before training', {
            agentId,
            error: err instanceof Error ? err.message : 'Unknown',
          });
        }

        const jobData: TrainingJobData = {
          agentId,
          epochs,
          learningRate,
          batchSize,
        };

        const job = await trainingQueue.add(`train-${agentId}`, jobData, {
          priority: 1,
          jobId: `train-${agentId}-${Date.now()}`,
        });

        // Estimate completion: base 5 minutes + 1 minute per 10 epochs
        const baseMs = 5 * 60 * 1000;
        const epochMs = ((epochs ?? 50) / 10) * 60 * 1000;
        const estimatedCompletionMs = baseMs + epochMs;

        logger.info('Training job enqueued', {
          jobId: job.id,
          agentId,
          epochs,
          learningRate,
          batchSize,
        });

        return reply.code(202).send({
          jobId: job.id,
          status: 'queued',
          agentId,
          estimatedCompletionMs,
          config: { epochs: epochs ?? 50, learningRate: learningRate ?? 0.001, batchSize: batchSize ?? 32 },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to enqueue training job';
        logger.error('Training enqueue failed', { agentId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /avatar/model/:agentId
   * Get the current active model information for an agent.
   */
  fastify.get(
    '/avatar/model/:agentId',
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
        const model = await warzoneClient.getModel(agentId);

        if (!model) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `No active model found for agent ${agentId}`,
            statusCode: 404,
          });
        }

        return reply.code(200).send({
          modelId: model.modelId,
          version: model.version,
          accuracy: model.accuracy,
          storageHash: model.storageHash,
          isActive: model.isActive,
          framework: model.framework,
          trainingDatasetSize: model.trainingDatasetSize,
          createdAt: model.createdAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch model info';
        logger.error('Model info fetch failed', { agentId, error: message });

        if (message.includes('circuit breaker')) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'AI Warzone service is temporarily unavailable',
            statusCode: 503,
          });
        }

        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * POST /avatar/predict
   * Run inference for a given game state using the agent's active model.
   */
  fastify.post(
    '/avatar/predict',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = PredictSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Request body validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const { agentId, gameState, topK } = parseResult.data;

      try {
        const prediction = await behaviorService.processPrediction(agentId, gameState, topK);

        return reply.code(200).send({
          agentId,
          actions: prediction.actions,
          confidence: prediction.confidence,
          inferenceTimeMs: prediction.inferenceTimeMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Prediction failed';
        logger.error('Prediction failed', { agentId, error: message });

        if (message.includes('circuit breaker')) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'AI Warzone service is temporarily unavailable',
            statusCode: 503,
          });
        }

        if (message.includes('No active model') || message.includes('not found')) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `No active model available for agent ${agentId}`,
            statusCode: 404,
          });
        }

        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /avatar/training/:jobId/status
   * Poll the status of a training job.
   */
  fastify.get(
    '/avatar/training/:jobId/status',
    async (
      request: FastifyRequest<{ Params: { jobId: string } }>,
      reply: FastifyReply
    ) => {
      const { jobId } = request.params;

      try {
        const job = await trainingQueue.getJob(jobId);

        if (!job) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Training job ${jobId} not found`,
            statusCode: 404,
          });
        }

        const state = await job.getState();
        const progress = job.progress;

        return reply.code(200).send({
          jobId: job.id,
          agentId: job.data.agentId,
          status: state,
          progress: typeof progress === 'number' ? progress : 0,
          failedReason: job.failedReason,
          returnvalue: job.returnvalue as unknown,
          createdAt: new Date(job.timestamp).toISOString(),
          processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
          finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );
}
