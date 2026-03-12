import { Worker, Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import axios from 'axios';
import { Logger } from 'winston';
import { WarzoneClient, TrainingConfig } from '../integrations/warzone.client';

// ─── Job data types ───────────────────────────────────────────────────────────

export interface TrainingJobData {
  agentId: string;
  epochs?: number;
  learningRate?: number;
  batchSize?: number;
  requestedBy?: string;
}

export interface TrainingJobResult {
  agentId: string;
  jobId: string;
  modelId?: string;
  accuracy?: number;
  storageHash?: string;
  durationMs: number;
}

// ─── Queue names ──────────────────────────────────────────────────────────────

export const TRAINING_QUEUE_NAME = 'avatar-training';
export const TRAINING_EVENTS_CHANNEL = 'kult:training:events';

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;   // Poll Warzone every 5 seconds
const MAX_POLL_ATTEMPTS = 120;    // Give up after 10 minutes (120 * 5s)
const MODEL_REGISTRY_URL =
  process.env.MODEL_REGISTRY_URL ?? 'http://model-registry-service:3002';

// ─── Training worker ──────────────────────────────────────────────────────────

export class TrainingWorker {
  private worker: Worker<TrainingJobData, TrainingJobResult>;
  private readonly warzoneClient: WarzoneClient;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {
    this.warzoneClient = new WarzoneClient(logger);

    this.worker = new Worker<TrainingJobData, TrainingJobResult>(
      TRAINING_QUEUE_NAME,
      async (job) => this.processTrainingJob(job),
      {
        connection: redis,
        concurrency: parseInt(process.env.TRAINING_WORKER_CONCURRENCY ?? '2', 10),
        limiter: {
          max: 5,
          duration: 60_000, // Max 5 training jobs per minute
        },
      }
    );

    this.setupWorkerListeners();
  }

  private setupWorkerListeners(): void {
    this.worker.on('completed', (job, result) => {
      this.logger.info('Training job completed', {
        jobId: job.id,
        agentId: result.agentId,
        modelId: result.modelId,
        accuracy: result.accuracy,
        durationMs: result.durationMs,
      });
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error('Training job failed', {
        jobId: job?.id,
        agentId: job?.data.agentId,
        error: err.message,
      });

      // Publish failure event to Redis pub/sub
      if (job) {
        void this.publishEvent({
          type: 'training:failed',
          agentId: job.data.agentId,
          jobId: job.id ?? '',
          error: err.message,
          timestamp: new Date().toISOString(),
        });
      }
    });

    this.worker.on('error', (err) => {
      this.logger.error('Training worker error', { error: err.message });
    });

    this.worker.on('stalled', (jobId) => {
      this.logger.warn('Training job stalled', { jobId });
    });
  }

  private async processTrainingJob(
    job: Job<TrainingJobData, TrainingJobResult>
  ): Promise<TrainingJobResult> {
    const { agentId, epochs, learningRate, batchSize } = job.data;
    const startTime = Date.now();

    this.logger.info('Processing training job', {
      jobId: job.id,
      agentId,
      epochs,
      learningRate,
      batchSize,
    });

    await job.updateProgress(5);

    // Step 1: Trigger training on Warzone service
    const trainingConfig: TrainingConfig = {
      epochs: epochs ?? 50,
      learningRate: learningRate ?? 0.001,
      batchSize: batchSize ?? 32,
    };

    const trainingJob = await this.warzoneClient.triggerTraining(agentId, trainingConfig);

    this.logger.info('Training triggered on Warzone', {
      warzoneJobId: trainingJob.jobId,
      agentId,
    });

    await job.updateProgress(10);

    // Step 2: Poll for completion
    let pollAttempts = 0;
    let completed = false;
    let storageHash: string | undefined;
    let accuracy: number | undefined;

    while (pollAttempts < MAX_POLL_ATTEMPTS && !completed) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const status = await this.warzoneClient.getTrainingStatus(trainingJob.jobId);

      this.logger.debug('Training poll', {
        warzoneJobId: trainingJob.jobId,
        status: status.status,
        progress: status.progress,
        attempt: pollAttempts + 1,
      });

      // Update BullMQ job progress (10% to 90% mapped from training progress)
      if (status.progress !== undefined) {
        const mappedProgress = 10 + Math.floor(status.progress * 0.8);
        await job.updateProgress(mappedProgress);
      }

      if (status.status === 'completed') {
        storageHash = status.storageHash;
        accuracy = status.accuracy;
        completed = true;
        break;
      }

      if (status.status === 'failed') {
        throw new Error(
          `Warzone training job ${trainingJob.jobId} failed: ${status.error ?? 'Unknown error'}`
        );
      }

      pollAttempts += 1;
    }

    if (!completed) {
      throw new Error(
        `Training timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS}ms. ` +
          `Warzone job ${trainingJob.jobId} did not complete.`
      );
    }

    await job.updateProgress(90);

    // Step 3: Register model in model-registry-service
    let registeredModelId: string | undefined;

    if (storageHash) {
      try {
        registeredModelId = await this.registerModelInRegistry({
          agentId,
          storageHash,
          accuracy: accuracy ?? 0,
          framework: 'tfjs',
        });

        this.logger.info('Model registered in registry', {
          modelId: registeredModelId,
          agentId,
          storageHash,
        });
      } catch (err) {
        // Registry registration failure should not block the job - log and continue
        this.logger.error('Failed to register model in registry', {
          agentId,
          storageHash,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    await job.updateProgress(95);

    // Step 4: Publish success event
    await this.publishEvent({
      type: 'training:completed',
      agentId,
      jobId: job.id ?? '',
      modelId: registeredModelId,
      accuracy,
      storageHash,
      timestamp: new Date().toISOString(),
    });

    await job.updateProgress(100);

    const durationMs = Date.now() - startTime;

    return {
      agentId,
      jobId: trainingJob.jobId,
      modelId: registeredModelId,
      accuracy,
      storageHash,
      durationMs,
    };
  }

  /**
   * Register the trained model in the model-registry-service via internal HTTP call.
   */
  private async registerModelInRegistry(data: {
    agentId: string;
    storageHash: string;
    accuracy: number;
    framework: string;
  }): Promise<string> {
    const registryClient = axios.create({
      baseURL: MODEL_REGISTRY_URL,
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Name': 'avatar-ai-service',
        ...(process.env.INTERNAL_API_KEY
          ? { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY }
          : {}),
      },
    });

    // Register model
    const registerResponse = await registryClient.post<{ model: { modelId: string } }>(
      '/models',
      {
        agentId: data.agentId,
        storageHash: data.storageHash,
        accuracy: data.accuracy,
        framework: data.framework,
        metadata: {
          registeredBy: 'avatar-ai-service',
          registeredAt: new Date().toISOString(),
        },
      }
    );

    const modelId = registerResponse.data.model.modelId;

    // Activate the newly registered model
    await registryClient.patch(`/models/${modelId}/activate`, {
      agentId: data.agentId,
    });

    return modelId;
  }

  /**
   * Publish a training event to Redis pub/sub for downstream consumers.
   */
  private async publishEvent(event: Record<string, unknown>): Promise<void> {
    try {
      // Use a separate Redis client for pub/sub to avoid blocking the main connection
      await this.redis.publish(TRAINING_EVENTS_CHANNEL, JSON.stringify(event));
    } catch (err) {
      this.logger.error('Failed to publish training event', {
        event,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  async close(): Promise<void> {
    await this.worker.close();
    this.logger.info('Training worker closed');
  }
}

// ─── Queue factory ────────────────────────────────────────────────────────────

export function createTrainingQueue(redis: Redis): Queue<TrainingJobData, TrainingJobResult> {
  return new Queue<TrainingJobData, TrainingJobResult>(TRAINING_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10_000, // 10s initial backoff
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  });
}
