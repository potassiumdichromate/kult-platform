import { PrismaClient, Model } from '@prisma/client';
import { Logger } from 'winston';
import { StorageService } from './storage.service';

export interface RegisterModelData {
  agentId: string;
  storageHash: string;
  version?: number;
  trainingDatasetSize?: number;
  accuracy?: number;
  modelSize?: bigint;
  framework?: string;
  metadata?: Record<string, unknown>;
}

export interface PaginatedModels {
  models: Model[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class ModelService {
  private readonly storageService: StorageService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger
  ) {
    this.storageService = new StorageService(logger);
  }

  /**
   * Register a new model version.
   * Validates that the storageHash is accessible on 0G before persisting.
   * Auto-determines next version number if not explicitly provided.
   */
  async registerModel(data: RegisterModelData): Promise<Model> {
    this.logger.info('Registering new model', {
      agentId: data.agentId,
      storageHash: data.storageHash,
      version: data.version,
    });

    // Verify the storage hash exists on 0G
    const verification = await this.storageService.verifyStorageHash(data.storageHash);
    if (!verification.exists) {
      throw new Error(
        `Storage hash "${data.storageHash}" could not be verified on 0G network. ` +
          `Ensure the model has been uploaded before registration.`
      );
    }

    // Determine version number - auto-increment if not supplied
    let version = data.version;
    if (version === undefined || version === null) {
      const latest = await this.prisma.model.findFirst({
        where: { agentId: data.agentId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      version = (latest?.version ?? 0) + 1;
    }

    // Check for duplicate version / storageHash
    const existing = await this.prisma.model.findFirst({
      where: {
        agentId: data.agentId,
        version,
      },
    });

    if (existing) {
      throw new Error(
        `Version ${version} already exists for agent ${data.agentId}. ` +
          `Omit the version field to auto-increment.`
      );
    }

    // Determine model size from storage verification if not provided
    const modelSize =
      data.modelSize ??
      (verification.size !== undefined ? BigInt(verification.size) : BigInt(0));

    // New model is not active by default - caller must explicitly activate it
    const model = await this.prisma.model.create({
      data: {
        agentId: data.agentId,
        storageHash: data.storageHash,
        version,
        trainingDatasetSize: data.trainingDatasetSize ?? 0,
        accuracy: data.accuracy ?? 0.0,
        modelSize,
        framework: data.framework ?? 'tensorflow',
        isActive: false,
        metadata: data.metadata ?? {},
      },
    });

    this.logger.info('Model registered successfully', {
      modelId: model.modelId,
      agentId: model.agentId,
      version: model.version,
    });

    return model;
  }

  /**
   * Get a model by its ID.
   */
  async getModelById(modelId: string): Promise<Model | null> {
    return this.prisma.model.findUnique({
      where: { modelId },
    });
  }

  /**
   * Get all models for an agent, paginated and ordered by version descending.
   */
  async getModelsByAgent(agentId: string, page: number, limit: number): Promise<PaginatedModels> {
    const offset = (page - 1) * limit;

    const [models, total] = await this.prisma.$transaction([
      this.prisma.model.findMany({
        where: { agentId },
        orderBy: { version: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.model.count({ where: { agentId } }),
    ]);

    return {
      models,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get the currently active model for an agent.
   * Throws if no active model exists.
   */
  async getActiveModel(agentId: string): Promise<Model> {
    const model = await this.prisma.model.findFirst({
      where: { agentId, isActive: true },
    });

    if (!model) {
      throw new Error(`No active model found for agent ${agentId}`);
    }

    return model;
  }

  /**
   * Activate a model for an agent.
   * Atomically deactivates all other models for the same agent and activates the target.
   * Uses a Prisma transaction to ensure atomicity.
   */
  async activateModel(modelId: string, agentId: string): Promise<Model> {
    this.logger.info('Activating model', { modelId, agentId });

    const target = await this.prisma.model.findUnique({
      where: { modelId },
    });

    if (!target) {
      throw new Error(`Model ${modelId} not found`);
    }

    if (target.agentId !== agentId) {
      throw new Error(
        `Model ${modelId} does not belong to agent ${agentId}. ` +
          `Attempted activation of a foreign model is not allowed.`
      );
    }

    if (target.isActive) {
      // Already active - idempotent, just return it
      this.logger.info('Model already active', { modelId });
      return target;
    }

    // Atomic swap inside a transaction
    const [, activated] = await this.prisma.$transaction([
      // Deactivate all models for this agent
      this.prisma.model.updateMany({
        where: { agentId, isActive: true },
        data: { isActive: false },
      }),
      // Activate the target model
      this.prisma.model.update({
        where: { modelId },
        data: { isActive: true },
      }),
    ]);

    this.logger.info('Model activated successfully', {
      modelId,
      agentId,
      version: activated.version,
    });

    return activated;
  }

  /**
   * Get paginated model version history for an agent, ordered oldest-first.
   */
  async getModelHistory(agentId: string, page: number, limit: number): Promise<PaginatedModels> {
    const offset = (page - 1) * limit;

    const [models, total] = await this.prisma.$transaction([
      this.prisma.model.findMany({
        where: { agentId },
        orderBy: { version: 'asc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.model.count({ where: { agentId } }),
    ]);

    return {
      models,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get the download URL for a model's stored artifact.
   */
  async getModelDownloadUrl(modelId: string): Promise<string> {
    const model = await this.prisma.model.findUnique({
      where: { modelId },
      select: { storageHash: true },
    });

    if (!model) {
      throw new Error(`Model ${modelId} not found`);
    }

    return this.storageService.getDownloadUrl(model.storageHash);
  }
}
