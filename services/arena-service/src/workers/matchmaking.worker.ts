import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import axios from 'axios';
import { Logger } from 'winston';
import { QueueService, QueueEntry } from '../services/queue.service';
import { MatchService } from '../services/match.service';
import { PrismaClient, MatchStatus } from '@prisma/client';

// ─── Queue and channel names ──────────────────────────────────────────────────

export const MATCHMAKING_QUEUE_NAME = 'arena-matchmaking';
export const MATCH_FOUND_CHANNEL = 'kult:arena:match-found';
export const MATCH_TIMEOUT_QUEUE_NAME = 'arena-match-timeout';

const MATCHMAKING_INTERVAL_MS = 5_000;
const ELO_BASE_RANGE = 200;
const ELO_RANGE_EXPANSION_PER_30S = 50;
const MATCH_TIMEOUT_SECONDS = parseInt(process.env.MATCH_TIMEOUT_SECONDS ?? '1800', 10); // 30 min
const AVATAR_SERVICE_URL = process.env.AVATAR_AI_SERVICE_URL ?? 'http://avatar-ai-service:3003';

// ─── Job types ────────────────────────────────────────────────────────────────

interface MatchmakingTickJobData {
  gameMode: string;
}

interface MatchTimeoutJobData {
  matchId: string;
}

// ─── ELO matching logic ───────────────────────────────────────────────────────

/**
 * Calculate the allowed ELO range for an agent based on how long they've waited.
 * Starts at ±200, expands by ±50 every 30 seconds.
 */
function getAllowedEloRange(waitTimeMs: number): number {
  const thirtySecondIntervals = Math.floor(waitTimeMs / 30_000);
  return ELO_BASE_RANGE + thirtySecondIntervals * ELO_RANGE_EXPANSION_PER_30S;
}

/**
 * Find the best match for an agent from the available queue entries.
 * Prefers the lowest ELO delta that fits within the allowed range.
 * Agents who have waited longer get wider ELO ranges (so they always eventually match).
 */
function findBestMatch(
  candidate: QueueEntry,
  others: QueueEntry[],
  now: number
): QueueEntry | null {
  const waitTime = now - candidate.joinedAt;
  const allowedRange = getAllowedEloRange(waitTime);

  // Filter agents within ELO range (use the wider of the two agents' ranges)
  const eligible = others.filter((other) => {
    const otherWaitTime = now - other.joinedAt;
    const otherAllowedRange = getAllowedEloRange(otherWaitTime);
    const effectiveRange = Math.max(allowedRange, otherAllowedRange);
    const eloDelta = Math.abs(candidate.eloRating - other.eloRating);
    return eloDelta <= effectiveRange;
  });

  if (eligible.length === 0) return null;

  // Among eligible, prefer the closest ELO
  eligible.sort(
    (a, b) =>
      Math.abs(a.eloRating - candidate.eloRating) -
      Math.abs(b.eloRating - candidate.eloRating)
  );

  return eligible[0] ?? null;
}

// ─── Matchmaking Worker ───────────────────────────────────────────────────────

export class MatchmakingWorker {
  private readonly worker: Worker<MatchmakingTickJobData>;
  private readonly timeoutWorker: Worker<MatchTimeoutJobData>;
  private readonly matchmakingQueue: Queue<MatchmakingTickJobData>;
  private readonly timeoutQueue: Queue<MatchTimeoutJobData>;
  private readonly queueService: QueueService;
  private readonly matchService: MatchService;
  private repeatableJobId: string | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient,
    private readonly logger: Logger
  ) {
    this.queueService = new QueueService(redis, logger);
    this.matchService = new MatchService(prisma, logger);

    this.matchmakingQueue = new Queue<MatchmakingTickJobData>(MATCHMAKING_QUEUE_NAME, {
      connection: redis,
    });

    this.timeoutQueue = new Queue<MatchTimeoutJobData>(MATCH_TIMEOUT_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });

    this.worker = new Worker<MatchmakingTickJobData>(
      MATCHMAKING_QUEUE_NAME,
      async (job) => this.processTick(job),
      {
        connection: redis,
        concurrency: 1, // Single worker to avoid race conditions in matchmaking
      }
    );

    this.timeoutWorker = new Worker<MatchTimeoutJobData>(
      MATCH_TIMEOUT_QUEUE_NAME,
      async (job) => this.processMatchTimeout(job),
      {
        connection: redis,
        concurrency: 5,
      }
    );

    this.setupWorkerListeners();
  }

  private setupWorkerListeners(): void {
    this.worker.on('error', (err) => {
      this.logger.error('Matchmaking worker error', { error: err.message });
    });

    this.timeoutWorker.on('error', (err) => {
      this.logger.error('Match timeout worker error', { error: err.message });
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error('Matchmaking tick failed', {
        jobId: job?.id,
        error: err.message,
      });
    });
  }

  /**
   * Start the matchmaking ticker. Runs every MATCHMAKING_INTERVAL_MS.
   * Creates one repeatable job per game mode.
   */
  async start(): Promise<void> {
    // Remove old repeatable jobs to avoid duplicates on restart
    const existingRepeatables = await this.matchmakingQueue.getRepeatableJobs();
    for (const job of existingRepeatables) {
      await this.matchmakingQueue.removeRepeatableByKey(job.key);
    }

    // Schedule the repeatable matchmaking tick
    await this.matchmakingQueue.add(
      'matchmaking-tick',
      { gameMode: 'all' },
      {
        repeat: {
          every: MATCHMAKING_INTERVAL_MS,
        },
        removeOnComplete: 1,
        removeOnFail: 1,
      }
    );

    this.logger.info('Matchmaking worker started', {
      intervalMs: MATCHMAKING_INTERVAL_MS,
    });
  }

  /**
   * Main matchmaking tick. Called every 5 seconds.
   * Processes all active game modes and finds matches.
   */
  private async processTick(_job: Job<MatchmakingTickJobData>): Promise<void> {
    const gameModes = await this.queueService.getActiveGameModes();

    for (const gameMode of gameModes) {
      try {
        await this.processGameModeMatchmaking(gameMode);
      } catch (err) {
        this.logger.error('Error during matchmaking tick for game mode', {
          gameMode,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Process matchmaking for a single game mode.
   * Iterates through queued agents and pairs them up greedily.
   */
  private async processGameModeMatchmaking(gameMode: string): Promise<void> {
    const agents = await this.queueService.getQueuedAgents(gameMode);

    if (agents.length < 2) {
      return; // Not enough agents to form a match
    }

    this.logger.debug('Processing matchmaking', { gameMode, agentCount: agents.length });

    const now = Date.now();
    const matched = new Set<string>();

    for (const candidate of agents) {
      if (matched.has(candidate.agentId)) continue;

      const available = agents.filter(
        (a) => a.agentId !== candidate.agentId && !matched.has(a.agentId)
      );

      if (available.length === 0) break;

      const opponent = findBestMatch(candidate, available, now);

      if (!opponent) {
        this.logger.debug('No suitable match found for agent', {
          agentId: candidate.agentId,
          waitTimeMs: now - candidate.joinedAt,
          eloRating: candidate.eloRating,
        });
        continue;
      }

      // Match found! Process it.
      try {
        await this.createMatchFromQueue(candidate, opponent, gameMode);
        matched.add(candidate.agentId);
        matched.add(opponent.agentId);

        this.logger.info('Match created from queue', {
          agent1Id: candidate.agentId,
          agent2Id: opponent.agentId,
          agent1Elo: candidate.eloRating,
          agent2Elo: opponent.eloRating,
          eloDelta: Math.abs(candidate.eloRating - opponent.eloRating),
          gameMode,
        });
      } catch (err) {
        this.logger.error('Failed to create match from queue', {
          agent1Id: candidate.agentId,
          agent2Id: opponent.agentId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Execute the full match creation flow:
   * 1. Remove both agents from Redis queue (atomic)
   * 2. Create Match record in PostgreSQL
   * 3. Notify avatar-ai-service
   * 4. Publish match-found event to Redis pub/sub
   * 5. Schedule match timeout job
   */
  private async createMatchFromQueue(
    agent1: QueueEntry,
    agent2: QueueEntry,
    gameMode: string
  ): Promise<void> {
    // Step 1: Remove both agents from queue
    await this.queueService.removeAgentsFromQueue(
      [agent1.agentId, agent2.agentId],
      gameMode
    );

    // Step 2: Create match in DB
    const match = await this.matchService.createMatch({
      agent1Id: agent1.agentId,
      agent2Id: agent2.agentId,
      gameMode,
      metadata: {
        agent1Elo: agent1.eloRating,
        agent2Elo: agent2.eloRating,
        eloDelta: Math.abs(agent1.eloRating - agent2.eloRating),
        agent1WaitMs: Date.now() - agent1.joinedAt,
        agent2WaitMs: Date.now() - agent2.joinedAt,
        matchedAt: new Date().toISOString(),
      },
    });

    // Transition to ACTIVE immediately after creation
    await this.matchService.activateMatch(match.matchId);

    // Step 3: Notify avatar-ai-service (non-blocking)
    this.notifyAvatarService(match.matchId, agent1.agentId, agent2.agentId, gameMode).catch(
      (err) => {
        this.logger.warn('Failed to notify avatar service of match', {
          matchId: match.matchId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    );

    // Step 4: Publish match-found event to Redis pub/sub for WebSocket delivery
    const matchFoundEvent = {
      type: 'match:found',
      matchId: match.matchId,
      agent1Id: agent1.agentId,
      agent2Id: agent2.agentId,
      gameMode,
      timestamp: new Date().toISOString(),
    };

    await this.redis.publish(MATCH_FOUND_CHANNEL, JSON.stringify(matchFoundEvent));

    // Step 5: Schedule match timeout
    await this.timeoutQueue.add(
      `timeout-${match.matchId}`,
      { matchId: match.matchId },
      {
        delay: MATCH_TIMEOUT_SECONDS * 1000,
        jobId: `timeout-${match.matchId}`,
      }
    );
  }

  /**
   * Handle match timeout - cancel if still active after the timeout window.
   */
  private async processMatchTimeout(job: Job<MatchTimeoutJobData>): Promise<void> {
    const { matchId } = job.data;

    const match = await this.matchService.getMatchById(matchId);

    if (!match) {
      this.logger.warn('Match not found during timeout check', { matchId });
      return;
    }

    if (match.status === MatchStatus.COMPLETED || match.status === MatchStatus.CANCELLED) {
      // Already resolved, nothing to do
      return;
    }

    this.logger.warn('Match timed out, cancelling', { matchId });
    await this.matchService.cancelMatch(matchId, 'Match timed out');

    // Notify via pub/sub
    await this.redis.publish(
      MATCH_FOUND_CHANNEL,
      JSON.stringify({
        type: 'match:timeout',
        matchId,
        timestamp: new Date().toISOString(),
      })
    );
  }

  /**
   * Notify the avatar-ai-service that a match has been found,
   * so it can prepare model inference for both agents.
   */
  private async notifyAvatarService(
    matchId: string,
    agent1Id: string,
    agent2Id: string,
    gameMode: string
  ): Promise<void> {
    const client = axios.create({
      baseURL: AVATAR_SERVICE_URL,
      timeout: 5_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Name': 'arena-service',
        ...(process.env.INTERNAL_API_KEY
          ? { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY }
          : {}),
      },
    });

    await client.post('/avatar/match-notify', {
      matchId,
      agent1Id,
      agent2Id,
      gameMode,
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.timeoutWorker.close();
    await this.matchmakingQueue.close();
    await this.timeoutQueue.close();
    this.logger.info('Matchmaking worker closed');
  }
}
