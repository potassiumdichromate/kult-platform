/**
 * ELO rating calculation service.
 *
 * Implements the standard ELO system with dynamic K-factor adjustment
 * based on number of games played (similar to FIDE chess rating system).
 *
 * K-Factor rules:
 *   - gamesPlayed < 30:  K = 32 (new players, fast rating movement)
 *   - gamesPlayed < 100: K = 24 (developing players)
 *   - gamesPlayed >= 100: K = 16 (established players, stable rating)
 *
 * Additionally, high-rated players (>= 2400) get K = 12 regardless of games.
 */

export interface ELOResult {
  winnerNew: number;
  loserNew: number;
  winnerChange: number;
  loserChange: number;
  winnerExpected: number;
  loserExpected: number;
  kFactor: number;
}

/**
 * Returns the K-factor for a player based on their current rating and games played.
 */
export function getKFactor(rating: number, gamesPlayed: number): number {
  // Elite players have highly stable ratings
  if (rating >= 2400) {
    return 12;
  }
  // New players — fast convergence to true skill
  if (gamesPlayed < 30) {
    return 32;
  }
  // Developing players
  if (gamesPlayed < 100) {
    return 24;
  }
  // Established players
  return 16;
}

/**
 * Calculates the expected score (probability of winning) for player A against player B.
 * Uses the standard ELO expected score formula.
 *
 * @param ratingA - ELO rating of player A
 * @param ratingB - ELO rating of player B
 * @returns Expected score for player A (0 to 1)
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Calculates new ELO ratings for both players after a match.
 * Winner gets score = 1, loser gets score = 0 (standard 1v1 result).
 *
 * @param winnerRating - Current ELO of the winner
 * @param loserRating - Current ELO of the loser
 * @param winnerGamesPlayed - Number of matches the winner has played
 * @param loserGamesPlayed - Number of matches the loser has played
 * @returns Updated ratings and deltas for both players
 */
export function calculateELO(
  winnerRating: number,
  loserRating: number,
  winnerGamesPlayed: number,
  loserGamesPlayed: number
): ELOResult {
  const winnerExpected = expectedScore(winnerRating, loserRating);
  const loserExpected = expectedScore(loserRating, winnerRating);

  // Use winner's K-factor (some systems use average; we use winner's for consistency)
  const kFactor = getKFactor(winnerRating, winnerGamesPlayed);
  const loserKFactor = getKFactor(loserRating, loserGamesPlayed);

  // Actual scores: winner gets 1, loser gets 0
  const winnerActual = 1;
  const loserActual = 0;

  const winnerChange = Math.round(kFactor * (winnerActual - winnerExpected));
  const loserChange = Math.round(loserKFactor * (loserActual - loserExpected));

  // ELO floor at 100 — no player can go below this
  const ELO_FLOOR = 100;
  const winnerNew = Math.max(ELO_FLOOR, winnerRating + winnerChange);
  const loserNew = Math.max(ELO_FLOOR, loserRating + loserChange);

  return {
    winnerNew,
    loserNew,
    winnerChange,
    loserChange,
    winnerExpected: Math.round(winnerExpected * 1000) / 1000,
    loserExpected: Math.round(loserExpected * 1000) / 1000,
    kFactor,
  };
}

/**
 * Returns the rank tier name for a given ELO rating.
 */
export function getRankTier(elo: number): string {
  if (elo >= 2400) return 'Grandmaster';
  if (elo >= 2200) return 'Master';
  if (elo >= 2000) return 'Diamond';
  if (elo >= 1800) return 'Platinum';
  if (elo >= 1600) return 'Gold';
  if (elo >= 1400) return 'Silver';
  if (elo >= 1200) return 'Bronze';
  return 'Iron';
}

/**
 * Returns the initial ELO rating for a new player.
 */
export const INITIAL_ELO = 1200;
