// =============================================================================
// KULT Platform — Ethereum Wallet Signature Authentication
//
// Flow:
//   1. Client calls POST /auth/nonce  → receives { nonce, message }
//   2. Client signs `message` with their private key (ethers / MetaMask)
//   3. Client calls POST /auth/verify → { wallet, nonce, signature }
//   4. Server calls verifyWalletSignature() and, on success, issues a JWT
// =============================================================================

import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import type { NonceResponse } from '../types/index.js';
import { UnauthorizedError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Nonces are valid for 5 minutes */
const NONCE_TTL_MS = 5 * 60 * 1_000;

/** Human-readable prefix shown in wallet signing dialogs */
const SIGN_PREFIX =
  'Sign this message to authenticate with KULT Platform.\n\nNonce: ';

// ---------------------------------------------------------------------------
// Nonce generation
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random hex nonce (32 bytes = 64 hex chars).
 */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Builds the full human-readable message a user must sign.
 * The message is deterministic given a nonce, so the server can reconstruct
 * it during verification without storing it.
 */
export function getSignMessage(nonce: string): string {
  return `${SIGN_PREFIX}${nonce}`;
}

/**
 * Returns a complete nonce response object for the `/auth/nonce` endpoint.
 */
export function createNonceResponse(nonce: string): NonceResponse {
  return {
    nonce,
    message: getSignMessage(nonce),
    expiresAt: Date.now() + NONCE_TTL_MS,
  };
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Recovers the signer address from an ECDSA signature and checks it matches
 * the claimed `address`.
 *
 * @param address   - Claimed Ethereum address (checksummed or lowercase)
 * @param nonce     - The nonce that was handed out by /auth/nonce
 * @param signature - Hex EIP-191 signature produced by the wallet
 * @returns `true` if the recovered address matches `address`
 * @throws `UnauthorizedError` on malformed input or mismatched address
 */
export function verifyWalletSignature(
  address: string,
  nonce: string,
  signature: string
): boolean {
  if (!address || !nonce || !signature) {
    throw new UnauthorizedError('address, nonce, and signature are required');
  }

  // Basic format guard — ethers will throw anyway, but gives a nicer message
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new UnauthorizedError('Malformed Ethereum address');
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new UnauthorizedError('Malformed signature — expected 65-byte hex');
  }

  const message = getSignMessage(nonce);

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(message, signature);
  } catch {
    throw new UnauthorizedError('Failed to recover signer from signature');
  }

  const normalised = address.toLowerCase();
  const recovered = recoveredAddress.toLowerCase();

  if (normalised !== recovered) {
    throw new UnauthorizedError(
      `Signature mismatch: expected ${normalised}, got ${recovered}`
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Address normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Returns the EIP-55 checksummed form of an address.
 * Useful before storing an address in the database.
 */
export function checksumAddress(address: string): string {
  try {
    return ethers.getAddress(address);
  } catch {
    throw new UnauthorizedError(`Invalid Ethereum address: ${address}`);
  }
}

/**
 * Returns `true` if the string is a syntactically valid EVM address.
 */
export function isValidAddress(address: string): boolean {
  return ethers.isAddress(address);
}

// ---------------------------------------------------------------------------
// Nonce store interface
// ---------------------------------------------------------------------------
// Concrete implementations live in the services (e.g. Redis-backed).
// This interface is here so the auth helpers remain storage-agnostic.

export interface NonceStore {
  /**
   * Persist a nonce for the given wallet.
   * Must expire automatically after NONCE_TTL_MS.
   */
  save(wallet: string, nonce: string): Promise<void>;

  /**
   * Retrieve and ATOMICALLY DELETE the nonce for a wallet.
   * Returns `null` if not found or expired.
   */
  consume(wallet: string): Promise<string | null>;
}

/**
 * Redis-compatible nonce store factory.
 * The caller is responsible for passing an ioredis-compatible `set` / `get`
 * so this module does not import redis directly.
 */
export function createRedisNonceStore(redis: {
  set: (
    key: string,
    value: string,
    expiryMode: 'PX',
    ttl: number
  ) => Promise<unknown>;
  getdel: (key: string) => Promise<string | null>;
}): NonceStore {
  const key = (wallet: string): string =>
    `kult:nonce:${wallet.toLowerCase()}`;

  return {
    async save(wallet, nonce) {
      await redis.set(key(wallet), nonce, 'PX', NONCE_TTL_MS);
    },

    async consume(wallet) {
      return redis.getdel(key(wallet));
    },
  };
}
