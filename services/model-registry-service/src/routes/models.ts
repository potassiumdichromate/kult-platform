import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { Logger } from 'winston';
import { z } from 'zod';
import { ModelService } from '../services/model.service';

// ─── Validation schemas ───────────────────────────────────────────────────────

const RegisterModelSchema = z.object({
  agentId: z.string().uuid('agentId must be a valid UUID'),
  storageHash: z.string().min(1, 'storageHash is required'),
  version: z.number().int().positive().optional(),
  trainingDatasetSize: z.number().int().nonnegative().optional(),
  accuracy: z.number().min(0).max(1).optional(),
  modelSize: z
    .union([z.string(), z.number()])
    .transform((v) => BigInt(v))
    .optional(),
  framework: z.enum(['tensorflow', 'pytorch', 'onnx', 'tfjs', 'other']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Route plugin ─────────────────────────────────────────────────────────────

export async function modelRoutes(
  fastify: FastifyInstance,
  opts: { prisma: PrismaClient; redis: Redis; logger: Logger }
): Promise<void> {
  const { prisma, logger } = opts;
  const modelService = new ModelService(prisma, logger);

  // Helper to serialize a model (BigInt fields need manual serialization)
  function serializeModel(model: {
    modelId: string;
    agentId: string;
    storageHash: string;
    version: number;
    trainingDatasetSize: number;
    accuracy: number;
    modelSize: bigint;
    framework: string;
    isActive: boolean;
    metadata: unknown;
    createdAt: Date;
  }): Record<string, unknown> {
    return {
      ...model,
      modelSize: model.modelSize.toString(),
      createdAt: model.createdAt.toISOString(),
    };
  }

  /**
   * POST /models
   * Register a new model version for an agent.
   */
  fastify.post(
    '/models',
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parseResult = RegisterModelSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Request body validation failed',
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      try {
        const model = await modelService.registerModel({
          ...parseResult.data,
          modelSize: parseResult.data.modelSize,
        });
        return reply.code(201).send({
          success: true,
          model: serializeModel(model),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to register model';
        logger.error('Model registration failed', { error: message, body: parseResult.data });

        if (message.includes('already exists') || message.includes('duplicate')) {
          return reply.code(409).send({ error: 'Conflict', message, statusCode: 409 });
        }
        if (message.includes('could not be verified') || message.includes('not found on 0G')) {
          return reply.code(422).send({
            error: 'Unprocessable Entity',
            message,
            statusCode: 422,
          });
        }
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /models/:modelId
   * Retrieve a model by its UUID.
   */
  fastify.get(
    '/models/:modelId',
    async (
      request: FastifyRequest<{ Params: { modelId: string } }>,
      reply: FastifyReply
    ) => {
      const { modelId } = request.params;

      const uuidCheck = z.string().uuid().safeParse(modelId);
      if (!uuidCheck.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'modelId must be a valid UUID',
          statusCode: 400,
        });
      }

      try {
        const model = await modelService.getModelById(modelId);
        if (!model) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Model ${modelId} not found`,
            statusCode: 404,
          });
        }
        return reply.code(200).send({ model: serializeModel(model) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Error fetching model', { modelId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /models/agent/:agentId
   * List all models for an agent with pagination.
   */
  fastify.get(
    '/models/agent/:agentId',
    async (
      request: FastifyRequest<{ Params: { agentId: string }; Querystring: unknown }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      const pageResult = PaginationSchema.safeParse(request.query);
      if (!pageResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid pagination parameters',
          details: pageResult.error.issues,
          statusCode: 400,
        });
      }

      const { page, limit } = pageResult.data;

      try {
        const result = await modelService.getModelsByAgent(agentId, page, limit);
        return reply.code(200).send({
          ...result,
          models: result.models.map(serializeModel),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Error fetching models for agent', { agentId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /models/agent/:agentId/active
   * Get the currently active model for an agent.
   */
  fastify.get(
    '/models/agent/:agentId/active',
    async (
      request: FastifyRequest<{ Params: { agentId: string } }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      try {
        const model = await modelService.getActiveModel(agentId);
        return reply.code(200).send({ model: serializeModel(model) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (message.includes('No active model')) {
          return reply.code(404).send({
            error: 'Not Found',
            message,
            statusCode: 404,
          });
        }
        logger.error('Error fetching active model', { agentId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * PATCH /models/:modelId/activate
   * Activate a specific model version (deactivates all others for that agent).
   */
  fastify.patch(
    '/models/:modelId/activate',
    async (
      request: FastifyRequest<{
        Params: { modelId: string };
        Body: unknown;
      }>,
      reply: FastifyReply
    ) => {
      const { modelId } = request.params;

      const bodySchema = z.object({
        agentId: z.string().uuid('agentId must be a valid UUID'),
      });

      const bodyResult = bodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'agentId is required in the request body',
          details: bodyResult.error.issues,
          statusCode: 400,
        });
      }

      const uuidCheck = z.string().uuid().safeParse(modelId);
      if (!uuidCheck.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'modelId must be a valid UUID',
          statusCode: 400,
        });
      }

      try {
        const model = await modelService.activateModel(modelId, bodyResult.data.agentId);
        return reply.code(200).send({
          success: true,
          model: serializeModel(model),
          message: `Model ${modelId} is now active`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message, statusCode: 404 });
        }
        if (message.includes('does not belong')) {
          return reply.code(403).send({ error: 'Forbidden', message, statusCode: 403 });
        }
        logger.error('Error activating model', { modelId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /models/agent/:agentId/history
   * Get version history for an agent, ordered chronologically.
   */
  fastify.get(
    '/models/agent/:agentId/history',
    async (
      request: FastifyRequest<{ Params: { agentId: string }; Querystring: unknown }>,
      reply: FastifyReply
    ) => {
      const { agentId } = request.params;

      const pageResult = PaginationSchema.safeParse(request.query);
      if (!pageResult.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid pagination parameters',
          details: pageResult.error.issues,
          statusCode: 400,
        });
      }

      const { page, limit } = pageResult.data;

      try {
        const result = await modelService.getModelHistory(agentId, page, limit);
        return reply.code(200).send({
          ...result,
          models: result.models.map(serializeModel),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Error fetching model history', { agentId, error: message });
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );

  /**
   * GET /models/:modelId/download-url
   * Get a download URL for a model artifact from 0G storage.
   */
  fastify.get(
    '/models/:modelId/download-url',
    async (
      request: FastifyRequest<{ Params: { modelId: string } }>,
      reply: FastifyReply
    ) => {
      const { modelId } = request.params;

      try {
        const url = await modelService.getModelDownloadUrl(modelId);
        return reply.code(200).send({ downloadUrl: url, expiresIn: 3600 });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message, statusCode: 404 });
        }
        return reply.code(500).send({ error: 'Internal Server Error', message, statusCode: 500 });
      }
    }
  );
}
