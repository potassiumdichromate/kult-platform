import mongoose, { Schema, Document, Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

export type EventType =
  | 'MOVE'
  | 'SHOOT'
  | 'DEATH'
  | 'KILL'
  | 'PICKUP'
  | 'ABILITY'
  | 'ROUND_START'
  | 'ROUND_END'
  | 'MATCH_END';

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface ITelemetryEvent {
  eventId: string;
  agentId: string;
  matchId: string;
  eventType: EventType;
  position?: Position;
  payload?: Record<string, unknown>;
  timestamp: Date;
}

export interface ITelemetryEventDocument extends ITelemetryEvent, Document {}

const PositionSchema = new Schema<Position>(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
  },
  { _id: false }
);

const TelemetryEventSchema = new Schema<ITelemetryEventDocument>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      default: () => uuidv4(),
      index: true,
    },
    agentId: {
      type: String,
      required: true,
      index: true,
    },
    matchId: {
      type: String,
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      enum: [
        'MOVE',
        'SHOOT',
        'DEATH',
        'KILL',
        'PICKUP',
        'ABILITY',
        'ROUND_START',
        'ROUND_END',
        'MATCH_END',
      ] satisfies EventType[],
    },
    position: {
      type: PositionSchema,
      required: false,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: false,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    collection: 'telemetry_events',
    versionKey: false,
  }
);

// Compound indexes for common query patterns
TelemetryEventSchema.index({ agentId: 1, matchId: 1 });
TelemetryEventSchema.index({ matchId: 1, timestamp: 1 });
TelemetryEventSchema.index({ timestamp: -1 });
// TTL index: auto-delete events older than 90 days
TelemetryEventSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_90days' }
);

export const TelemetryEvent: Model<ITelemetryEventDocument> =
  mongoose.model<ITelemetryEventDocument>('TelemetryEvent', TelemetryEventSchema);

export interface AgentStats {
  agentId: string;
  totalMatches: number;
  totalKills: number;
  totalDeaths: number;
  totalShots: number;
  kdRatio: number;
  averageKillsPerMatch: number;
  topWeaponPickups: Array<{ weaponId: string; count: number }>;
}
