// =============================================================================
// KULT Platform — ELO Rating System
//
// Implements the classic Elo rating formula (Arpad Elo, 1960) with:
//   - Variable K-factor based on rating and games played
//   - Support for three outcomes: win (1), draw (0.5), loss (0)
//   - Minimum rating floor to prevent negative ratings
//   - Batch update helpers for tournament bracket processing
// =============================================================================

import type { ELOResult } from '../types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The expected-score calculation uses base-10 scaling with divisor 400 */
const ELO_DIVISOR = 400;

/** No agent's rating can fall below this floor */
const MIN_RATING = 100;

/** Rating thresholds for dynamic K-factor */
const RATING_THRESHOLD_HIGH = 2400;
const RATING_THRESHOLD_MID = 2000;

/** Games-played threshold below which a higher provisional K is applied */
const PROVISIONAL_GAMES_THRESHOLD = 30;

// ---------------------------------------------------------------------------
// Core formula
// ---------------------------------------------------------------------------

/**
 * Calculates the expected score (probability of winning) for player A
 * against player B using the standard Elo formula.
 *
 * @returns A value in [0, 1]
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / ELO_DIVISOR));
}

// ---------------------------------------------------------------------------
// K-factor
// ---------------------------------------------------------------------------

/**
 * Returns the dynamic K-factor for a given rating and games played.
 *
 * Rules (FIDE-inspired):
 *   - Provisional players (< 30 games): K = 40
 *   - Rating >= 2400: K = 16
 *   - Rating >= 2000: K = 24
 *   - Everyone else: K = 32 (configurable via `defaultK`)
 *
 * @param rating      - Current ELO rating
 * @param gamesPlayed - Total games played to date
 * @param defaultK    - Base K-factor (default: 32)
 */
export function getKFactor(
  rating: number,
  gamesPlayed: number,
  defaultK = 32
): number {
  if (gamesPlayed < PROVISIONAL_GAMES_THRESHOLD) {
    return 40;
  }
  if (rating >= RATING_THRESHOLD_HIGH) {
    return 16;
  }
  if (rating >= RATING_THRESHOLD_MID) {
    return 24;
  }
  return defaultK;
}

// ---------------------------------------------------------------------------
// Main calculation
// ---------------------------------------------------------------------------

/**
 * Calculates new ELO ratings for two players after a match.
 *
 * @param rating1      - Player 1's current rating
 * @param rating2      - Player 2's current rating
 * @param outcome      - From Player 1's perspective: 1 = win, 0.5 = draw, 0 = loss
 * @param kFactor      - K-factor override (if not provided, uses getKFactor defaults)
 * @param gamesPlayed1 - Player 1's total games played (used to derive K if kFactor omitted)
 * @param gamesPlayed2 - Player 2's total games played (used to derive K if kFactor omitted)
 *
 * @returns ELOResult with new ratings and per-player deltas
 */
export function calculateELO(
  rating1: number,
  rating2: number,
  outcome: 0 | 0.5 | 1,
  kFactor?: number,
  gamesPlayed1 = 30,
  gamesPlayed2 = 30
): ELOResult {
  validateRating(rating1, 'rating1');
  validateRating(rating2, 'rating2');

  const k1 = kFactor ?? getKFactor(rating1, gamesPlayed1);
  const k2 = kFactor ?? getKFactor(rating2, gamesPlayed2);

  const expected1 = expectedScore(rating1, rating2);
  const expected2 = 1 - expected1;

  // outcome is from Player 1's perspective
  const actualScore1 = outcome;
  const actualScore2 = 1 - outcome;

  const rawChange1 = k1 * (actualScore1 - expected1);
  const rawChange2 = k2 * (actualScore2 - expected2);

  const change1 = Math.round(rawChange1);
  const change2 = Math.round(rawChange2);

  const newRating1 = Math.max(MIN_RATING, rating1 + change1);
  const newRating2 = Math.max(MIN_RATING, rating2 + change2);

  return {
    newRating1,
    newRating2,
    change1: newRating1 - rating1,
    change2: newRating2 - rating2,
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Calculates ELO changes after a decisive match (one winner, one loser).
 *
 * ```ts
 * const result = calculateMatchELO(1200, 1400);
 * // result.change1 > 0 (upset bonus for lower-rated player)
 * ```
 */
export function calculateMatchELO(
  winnerRating: number,
  loserRating: number,
  winnerGamesPlayed = 30,
  loserGamesPlayed = 30
): ELOResult {
  return calculateELO(
    winnerRating,
    loserRating,
    1, // winner perspective = 1
    undefined,
    winnerGamesPlayed,
    loserGamesPlayed
  );
}

/**
 * Calculates ELO changes for a drawn match.
 */
export function calculateDrawELO(
  rating1: number,
  rating2: number,
  gamesPlayed1 = 30,
  gamesPlayed2 = 30
): ELOResult {
  return calculateELO(
    rating1,
    rating2,
    0.5,
    undefined,
    gamesPlayed1,
    gamesPlayed2
  );
}

// ---------------------------------------------------------------------------
// Batch / tournament helpers
// ---------------------------------------------------------------------------

export interface PlayerState {
  agentId: string;
  rating: number;
  gamesPlayed: number;
}

export interface BracketMatchResult {
  winnerAgentId: string;
  loserAgentId: string;
  isDraw: boolean;
}

export interface BatchELOUpdate {
  agentId: string;
  ratingBefore: number;
  ratingAfter: number;
  change: number;
}

/**
 * Applies ELO updates for a list of match results in a tournament bracket.
 * Processes matches sequentially so earlier results affect later ones.
 *
 * @param players - Map of agentId → current PlayerState
 * @param results - Ordered list of match outcomes
 * @returns Array of per-agent rating updates
 */
export function processBracketResults(
  players: Map<string, PlayerState>,
  results: BracketMatchResult[]
): BatchELOUpdate[] {
  const updates: BatchELOUpdate[] = [];

  for (const result of results) {
    const winner = players.get(result.winnerAgentId);
    const loser = players.get(result.loserAgentId);

    if (!winner || !loser) {
      continue;
    }

    const eloResult = result.isDraw
      ? calculateDrawELO(
          winner.rating,
          loser.rating,
          winner.gamesPlayed,
          loser.gamesPlayed
        )
      : calculateMatchELO(
          winner.rating,
          loser.rating,
          winner.gamesPlayed,
          loser.gamesPlayed
        );

    updates.push(
      {
        agentId: winner.agentId,
        ratingBefore: winner.rating,
        ratingAfter: eloResult.newRating1,
        change: eloResult.change1,
      },
      {
        agentId: loser.agentId,
        ratingBefore: loser.rating,
        ratingAfter: eloResult.newRating2,
        change: eloResult.change2,
      }
    );

    // Update in-memory state so subsequent rounds use updated ratings
    winner.rating = eloResult.newRating1;
    winner.gamesPlayed += 1;
    loser.rating = eloResult.newRating2;
    loser.gamesPlayed += 1;
  }

  return updates;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateRating(rating: number, field: string): void {
  if (!Number.isFinite(rating)) {
    throw new TypeError(`ELO ${field} must be a finite number, got: ${rating}`);
  }
  if (rating < MIN_RATING) {
    throw new RangeError(
      `ELO ${field} must be >= ${MIN_RATING}, got: ${rating}`
    );
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable tier label for a given ELO rating.
 */
export function getTier(rating: number): string {
  if (rating >= 2500) return 'Grandmaster';
  if (rating >= 2300) return 'Master';
  if (rating >= 2100) return 'Expert';
  if (rating >= 1800) return 'Advanced';
  if (rating >= 1500) return 'Intermediate';
  if (rating >= 1200) return 'Beginner';
  return 'Unranked';
}

/**
 * Formats a rating change as a signed string e.g. "+12" or "-5".
 */
export function formatChange(change: number): string {
  return change >= 0 ? `+${change}` : `${change}`;
}
