import Redis from 'ioredis';
import { Logger } from 'winston';
import {
  WarzoneClient,
  GameAction,
  GameState,
  PredictionResult,
  BehaviorData,
} from '../integrations/warzone.client';

// ─── Constants ────────────────────────────────────────────────────────────────

const BEHAVIOR_BUFFER_KEY = (agentId: string) => `behavior:buffer:${agentId}`;
const BEHAVIOR_BUFFER_TTL_SECONDS = 300; // 5 minutes - flush if not manually triggered
const BUFFER_FLUSH_THRESHOLD = 50; // Auto-flush when buffer reaches 50 actions

export interface BehaviorRecord {
  agentId: string;
  matchId: string;
  actionSequence: GameAction[];
  gameState: GameState | Record<string, unknown>;
  timestamp: number;
}

export interface BatchResult {
  agentId: string;
  bufferedCount: number;
  flushed: boolean;
  recordId?: string;
}

// ─── Behavior Service ─────────────────────────────────────────────────────────

export class BehaviorService {
  constructor(
    private readonly warzoneClient: WarzoneClient,
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {}

  /**
   * Buffer behavioral data for an agent.
   * Stores the raw action sequence + game state in Redis.
   * Auto-flushes to Warzone API when buffer exceeds threshold.
   */
  async batchBehaviorData(
    agentId: string,
    matchId: string,
    actionSequence: GameAction[],
    gameState: GameState | Record<string, unknown>
  ): Promise<BatchResult> {
    const record: BehaviorRecord = {
      agentId,
      matchId,
      actionSequence,
      gameState,
      timestamp: Date.now(),
    };

    const bufferKey = BEHAVIOR_BUFFER_KEY(agentId);

    // Push serialized record to Redis list
    const pipeline = this.redis.pipeline();
    pipeline.rpush(bufferKey, JSON.stringify(record));
    pipeline.expire(bufferKey, BEHAVIOR_BUFFER_TTL_SECONDS);
    await pipeline.exec();

    // Get current buffer length
    const bufferLength = await this.redis.llen(bufferKey);

    this.logger.debug('Behavior data buffered', {
      agentId,
      matchId,
      actionCount: actionSequence.length,
      bufferLength,
    });

    // Auto-flush if threshold exceeded
    if (bufferLength >= BUFFER_FLUSH_THRESHOLD) {
      this.logger.info('Buffer flush threshold reached, auto-flushing', {
        agentId,
        bufferLength,
      });
      try {
        const flushResult = await this.flushBuffer(agentId);
        return {
          agentId,
          bufferedCount: bufferLength,
          flushed: true,
          recordId: flushResult.recordId,
        };
      } catch (err) {
        this.logger.error('Auto-flush failed', {
          agentId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        // Don't fail the buffering operation even if flush fails
      }
    }

    return {
      agentId,
      bufferedCount: bufferLength,
      flushed: false,
    };
  }

  /**
   * Flush all buffered behavior data for an agent to the Warzone service.
   * Aggregates all buffered records into a single batch call.
   */
  async flushBuffer(agentId: string): Promise<{ recordId: string; flushedCount: number }> {
    const bufferKey = BEHAVIOR_BUFFER_KEY(agentId);

    // Atomically read all records and clear the list
    const pipeline = this.redis.pipeline();
    pipeline.lrange(bufferKey, 0, -1);
    pipeline.del(bufferKey);
    const results = await pipeline.exec();

    if (!results) {
      throw new Error('Redis pipeline returned null results');
    }

    const rawRecords = results[0]?.[1] as string[] | undefined;

    if (!rawRecords || rawRecords.length === 0) {
      this.logger.debug('No buffered data to flush', { agentId });
      return { recordId: '', flushedCount: 0 };
    }

    const records: BehaviorRecord[] = rawRecords.map((raw) => {
      const parsed: unknown = JSON.parse(raw);
      return parsed as BehaviorRecord;
    });

    // Merge all action sequences and use the latest game state
    const mergedActionSequence: GameAction[] = records.flatMap((r) => r.actionSequence);
    const latestRecord = records[records.length - 1];

    if (!latestRecord) {
      throw new Error('No records found after parsing buffer');
    }

    const batchData: BehaviorData = {
      agentId,
      matchId: latestRecord.matchId,
      actionSequence: mergedActionSequence,
      gameState: latestRecord.gameState,
    };

    const result = await this.warzoneClient.recordBehavior(batchData);

    this.logger.info('Behavior buffer flushed to Warzone', {
      agentId,
      flushedRecords: records.length,
      totalActions: mergedActionSequence.length,
      recordId: result.recordId,
    });

    return {
      recordId: result.recordId,
      flushedCount: records.length,
    };
  }

  /**
   * Run prediction for an agent given a current game state.
   * Delegates to the active model via the Warzone inference API.
   */
  async processPrediction(
    agentId: string,
    gameState: GameState | Record<string, unknown>,
    topK = 5
  ): Promise<PredictionResult> {
    this.logger.debug('Running prediction', { agentId, topK });

    const result = await this.warzoneClient.runPrediction(agentId, gameState, topK);

    this.logger.debug('Prediction complete', {
      agentId,
      confidence: result.confidence,
      actionCount: result.actions.length,
      inferenceTimeMs: result.inferenceTimeMs,
    });

    return result;
  }

  /**
   * Get current buffer size for an agent (useful for monitoring).
   */
  async getBufferSize(agentId: string): Promise<number> {
    return this.redis.llen(BEHAVIOR_BUFFER_KEY(agentId));
  }

  /**
   * Clear the buffer for an agent without flushing (e.g., on match cancel).
   */
  async clearBuffer(agentId: string): Promise<void> {
    await this.redis.del(BEHAVIOR_BUFFER_KEY(agentId));
    this.logger.info('Behavior buffer cleared', { agentId });
  }
}
