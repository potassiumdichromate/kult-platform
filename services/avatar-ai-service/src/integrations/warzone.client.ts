import axios, {
  AxiosInstance,
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
} from 'axios';
import { Logger } from 'winston';

// ─── Warzone API types ────────────────────────────────────────────────────────

export interface GameAction {
  actionType: string;
  timestamp: number;
  position?: { x: number; y: number; z?: number };
  targetPosition?: { x: number; y: number; z?: number };
  rotation?: number;
  velocity?: { x: number; y: number; z?: number };
  weapon?: string;
  metadata?: Record<string, unknown>;
}

export interface GameState {
  mapId: string;
  tick: number;
  playerPosition: { x: number; y: number; z?: number };
  playerHealth: number;
  playerAmmo: number;
  enemies: Array<{
    id: string;
    position: { x: number; y: number; z?: number };
    health: number;
    distance: number;
  }>;
  gameMode: string;
  timeElapsed: number;
  metadata?: Record<string, unknown>;
}

export interface BehaviorData {
  agentId: string;
  matchId: string;
  actionSequence: GameAction[];
  gameState: GameState | Record<string, unknown>;
}

export interface TrainingConfig {
  epochs?: number;
  learningRate?: number;
  batchSize?: number;
}

export interface TrainingJobResponse {
  jobId: string;
  agentId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  estimatedCompletionMs?: number;
  startedAt?: string;
}

export interface ModelInfo {
  modelId: string;
  agentId: string;
  version: number;
  accuracy: number;
  storageHash: string;
  isActive: boolean;
  framework: string;
  trainingDatasetSize: number;
  createdAt: string;
}

export interface PredictionResult {
  actions: PredictedAction[];
  confidence: number;
  inferenceTimeMs: number;
}

export interface PredictedAction {
  actionType: string;
  probability: number;
  position?: { x: number; y: number; z?: number };
  metadata?: Record<string, unknown>;
}

export interface TrainingStatusResponse {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress?: number;
  accuracy?: number;
  storageHash?: string;
  error?: string;
  completedAt?: string;
}

// ─── Circuit breaker state ────────────────────────────────────────────────────

enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Failing, reject fast
  HALF_OPEN = 'HALF_OPEN', // Testing recovery
}

interface CircuitBreaker {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
}

// ─── Warzone HTTP Client ──────────────────────────────────────────────────────

export class WarzoneClient {
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private circuit: CircuitBreaker;

  private static readonly FAILURE_THRESHOLD = 5;
  private static readonly SUCCESS_THRESHOLD = 2;
  private static readonly OPEN_DURATION_MS = 30_000; // 30s open window
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_BASE_DELAY_MS = 500;

  constructor(private readonly logger: Logger) {
    this.baseUrl = process.env.WARZONE_SERVICE_URL ?? 'http://warzone-service:4000';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Name': 'avatar-ai-service',
        ...(process.env.INTERNAL_API_KEY
          ? { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY }
          : {}),
      },
    });

    this.circuit = {
      state: CircuitState.CLOSED,
      failureCount: 0,
      lastFailureTime: 0,
      successCount: 0,
    };

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.client.interceptors.request.use((config) => {
      this.logger.debug('Warzone request', {
        method: config.method?.toUpperCase(),
        url: config.url,
      });
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        this.logger.debug('Warzone response', {
          status: response.status,
          url: response.config.url,
        });
        return response;
      },
      (error: AxiosError) => {
        this.logger.warn('Warzone response error', {
          status: error.response?.status,
          message: error.message,
          url: error.config?.url,
        });
        return Promise.reject(error);
      }
    );
  }

  // ─── Circuit breaker logic ─────────────────────────────────────────────────

  private isCircuitOpen(): boolean {
    if (this.circuit.state === CircuitState.OPEN) {
      const elapsed = Date.now() - this.circuit.lastFailureTime;
      if (elapsed >= WarzoneClient.OPEN_DURATION_MS) {
        this.circuit.state = CircuitState.HALF_OPEN;
        this.circuit.successCount = 0;
        this.logger.info('Circuit breaker moved to HALF_OPEN, testing recovery');
        return false;
      }
      return true;
    }
    return false;
  }

  private recordSuccess(): void {
    if (this.circuit.state === CircuitState.HALF_OPEN) {
      this.circuit.successCount += 1;
      if (this.circuit.successCount >= WarzoneClient.SUCCESS_THRESHOLD) {
        this.circuit.state = CircuitState.CLOSED;
        this.circuit.failureCount = 0;
        this.logger.info('Circuit breaker CLOSED - Warzone service recovered');
      }
    } else if (this.circuit.state === CircuitState.CLOSED) {
      this.circuit.failureCount = 0;
    }
  }

  private recordFailure(): void {
    this.circuit.failureCount += 1;
    this.circuit.lastFailureTime = Date.now();

    if (
      this.circuit.state !== CircuitState.OPEN &&
      this.circuit.failureCount >= WarzoneClient.FAILURE_THRESHOLD
    ) {
      this.circuit.state = CircuitState.OPEN;
      this.logger.error('Circuit breaker OPEN - Warzone service is unavailable', {
        failureCount: this.circuit.failureCount,
      });
    }
  }

  // ─── Request wrapper with retry + circuit breaker ─────────────────────────

  private async request<T>(config: AxiosRequestConfig, retries = WarzoneClient.MAX_RETRIES): Promise<T> {
    if (this.isCircuitOpen()) {
      throw new Error('Warzone service circuit breaker is OPEN. Request rejected to prevent cascade failure.');
    }

    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response: AxiosResponse<T> = await this.client.request<T>(config);
        this.recordSuccess();
        return response.data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const isAxiosErr = axios.isAxiosError(err);
        const status = isAxiosErr ? err.response?.status : undefined;

        // Do not retry on 4xx client errors (except 429 rate limit)
        if (isAxiosErr && status !== undefined && status >= 400 && status < 500 && status !== 429) {
          this.recordFailure();
          throw lastError;
        }

        // Last attempt - record failure and throw
        if (attempt === retries) {
          this.recordFailure();
          throw lastError;
        }

        // Exponential backoff
        const delay = WarzoneClient.RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.random() * 200;
        this.logger.warn('Warzone request failed, retrying', {
          attempt: attempt + 1,
          maxRetries: retries,
          delayMs: delay + jitter,
          error: lastError.message,
        });

        await new Promise<void>((resolve) => setTimeout(resolve, delay + jitter));
      }
    }

    throw lastError;
  }

  // ─── Warzone API methods ──────────────────────────────────────────────────

  /**
   * Record a batch of behavioral data (actions + game state) for training.
   */
  async recordBehavior(data: BehaviorData): Promise<{ recordId: string; accepted: boolean }> {
    return this.request<{ recordId: string; accepted: boolean }>({
      method: 'POST',
      url: '/api/behavior/record',
      data,
    });
  }

  /**
   * Trigger model training for an agent with optional hyperparameter overrides.
   */
  async triggerTraining(agentId: string, config: TrainingConfig = {}): Promise<TrainingJobResponse> {
    return this.request<TrainingJobResponse>({
      method: 'POST',
      url: '/api/training/start',
      data: {
        agentId,
        epochs: config.epochs ?? 50,
        learningRate: config.learningRate ?? 0.001,
        batchSize: config.batchSize ?? 32,
      },
    });
  }

  /**
   * Poll training job status.
   */
  async getTrainingStatus(jobId: string): Promise<TrainingStatusResponse> {
    return this.request<TrainingStatusResponse>({
      method: 'GET',
      url: `/api/training/status/${jobId}`,
    });
  }

  /**
   * Get the current active model info for an agent.
   */
  async getModel(agentId: string): Promise<ModelInfo | null> {
    try {
      return await this.request<ModelInfo>({
        method: 'GET',
        url: `/api/model/${agentId}`,
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Run inference on a given game state using the agent's active model.
   */
  async runPrediction(
    agentId: string,
    gameState: GameState | Record<string, unknown>,
    topK = 5
  ): Promise<PredictionResult> {
    return this.request<PredictionResult>({
      method: 'POST',
      url: '/api/inference/predict',
      data: { agentId, gameState, topK },
    });
  }

  /**
   * Health check against the Warzone service.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.request<{ status: string }>({
        method: 'GET',
        url: '/health',
      }, 0);
      return true;
    } catch {
      return false;
    }
  }

  getCircuitState(): CircuitState {
    return this.circuit.state;
  }
}
