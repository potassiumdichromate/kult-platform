import { TelemetryEvent, ITelemetryEvent, AgentStats, EventType } from '../models/telemetry.model';
import { logger } from '../middleware/logger';
import { v4 as uuidv4 } from 'uuid';

const MAX_BATCH_SIZE = 100;

export interface BatchInsertResult {
  inserted: number;
  failed: number;
  errors: string[];
}

export interface ReplayData {
  matchId: string;
  agentId: string;
  eventCount: number;
  events: ITelemetryEvent[];
  startTime: Date | null;
  endTime: Date | null;
  durationMs: number;
}

export class TelemetryService {
  /**
   * Batch inserts up to 100 telemetry events into MongoDB.
   * Uses ordered: false for maximum throughput — individual event failures
   * don't block the rest of the batch.
   */
  async batchInsertEvents(
    events: Omit<ITelemetryEvent, 'eventId'>[]
  ): Promise<BatchInsertResult> {
    if (events.length === 0) {
      return { inserted: 0, failed: 0, errors: [] };
    }

    if (events.length > MAX_BATCH_SIZE) {
      throw new Error(`Batch size exceeds maximum of ${MAX_BATCH_SIZE}`);
    }

    const docs = events.map((e) => ({
      ...e,
      eventId: uuidv4(),
      timestamp: e.timestamp ?? new Date(),
    }));

    const errors: string[] = [];
    let inserted = 0;

    try {
      const result = await TelemetryEvent.insertMany(docs, {
        ordered: false,
        // Cast to any to satisfy mongoose typings for rawResult
      });
      inserted = result.length;
    } catch (err: unknown) {
      // BulkWriteError — some docs may have inserted despite errors
      if (
        err !== null &&
        typeof err === 'object' &&
        'insertedCount' in err &&
        'writeErrors' in err
      ) {
        const bulkErr = err as { insertedCount: number; writeErrors: Array<{ errmsg?: string }> };
        inserted = bulkErr.insertedCount;
        for (const writeErr of bulkErr.writeErrors) {
          errors.push(writeErr.errmsg ?? 'Unknown write error');
        }
      } else {
        throw err;
      }
    }

    const failed = docs.length - inserted;

    logger.info('Batch insert complete', {
      requested: docs.length,
      inserted,
      failed,
      errorCount: errors.length,
    });

    return { inserted, failed, errors };
  }

  /**
   * Returns all telemetry events for a match, sorted by timestamp ascending.
   * Suitable for replay reconstruction.
   */
  async getMatchEvents(matchId: string): Promise<ITelemetryEvent[]> {
    const events = await TelemetryEvent.find(
      { matchId },
      { _id: 0, __v: 0 }
    )
      .sort({ timestamp: 1 })
      .lean()
      .exec();

    return events as ITelemetryEvent[];
  }

  /**
   * Aggregates gameplay statistics for an agent across all their matches.
   */
  async getAgentStats(agentId: string): Promise<AgentStats> {
    const pipeline = [
      { $match: { agentId } },
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 },
          matchIds: { $addToSet: '$matchId' },
        },
      },
    ];

    type AggResult = { _id: EventType; count: number; matchIds: string[] };
    const aggregated = await TelemetryEvent.aggregate<AggResult>(pipeline).exec();

    const countsByType: Partial<Record<EventType, number>> = {};
    const matchIdSets: Set<string>[] = [];

    for (const row of aggregated) {
      countsByType[row._id] = row.count;
      matchIdSets.push(new Set(row.matchIds));
    }

    // Count unique matches
    const allMatchIds = new Set<string>();
    for (const set of matchIdSets) {
      for (const id of set) {
        allMatchIds.add(id);
      }
    }

    const totalKills = countsByType['KILL'] ?? 0;
    const totalDeaths = countsByType['DEATH'] ?? 0;
    const totalShots = countsByType['SHOOT'] ?? 0;
    const totalMatches = allMatchIds.size;

    const kdRatio = totalDeaths > 0 ? totalKills / totalDeaths : totalKills;
    const averageKillsPerMatch = totalMatches > 0 ? totalKills / totalMatches : 0;

    // Top weapon pickups
    const pickupPipeline = [
      { $match: { agentId, eventType: 'PICKUP' } },
      { $group: { _id: '$payload.weaponId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ];

    type PickupResult = { _id: string; count: number };
    const pickups = await TelemetryEvent.aggregate<PickupResult>(pickupPipeline).exec();

    return {
      agentId,
      totalMatches,
      totalKills,
      totalDeaths,
      totalShots,
      kdRatio: Math.round(kdRatio * 100) / 100,
      averageKillsPerMatch: Math.round(averageKillsPerMatch * 100) / 100,
      topWeaponPickups: pickups.map((p) => ({
        weaponId: p._id ?? 'unknown',
        count: p.count,
      })),
    };
  }

  /**
   * Returns full replay data for a specific agent in a specific match.
   * Includes all events in chronological order with timing metadata.
   */
  async getMatchReplay(agentId: string, matchId: string): Promise<ReplayData> {
    const events = await TelemetryEvent.find(
      { agentId, matchId },
      { _id: 0, __v: 0 }
    )
      .sort({ timestamp: 1 })
      .lean()
      .exec();

    const typed = events as ITelemetryEvent[];

    const startTime = typed.length > 0 ? typed[0]!.timestamp : null;
    const endTime = typed.length > 0 ? typed[typed.length - 1]!.timestamp : null;
    const durationMs =
      startTime && endTime ? endTime.getTime() - startTime.getTime() : 0;

    return {
      matchId,
      agentId,
      eventCount: typed.length,
      events: typed,
      startTime,
      endTime,
      durationMs,
    };
  }

  /**
   * Returns paginated events for a match (for streaming large replays).
   */
  async getMatchEventsPaginated(
    matchId: string,
    page: number,
    limit: number
  ): Promise<{ events: ITelemetryEvent[]; total: number; hasMore: boolean }> {
    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      TelemetryEvent.find({ matchId }, { _id: 0 })
        .sort({ timestamp: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      TelemetryEvent.countDocuments({ matchId }),
    ]);

    return {
      events: events as ITelemetryEvent[],
      total,
      hasMore: skip + limit < total,
    };
  }
}
