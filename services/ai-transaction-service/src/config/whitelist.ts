/**
 * Contract and method whitelist for the AI Transaction Policy Engine.
 *
 * SECURITY: Only contracts and methods listed here may be targeted by AI agent transactions.
 * Any transaction targeting a contract/method not in this whitelist is automatically rejected
 * by the policy engine before any signing or broadcasting occurs.
 */

export interface WhitelistedContract {
  address: string;
  methods: string[];
  description: string;
}

export const CONTRACT_WHITELIST: Record<string, WhitelistedContract> = {
  GAME_ECONOMY: {
    address: (process.env['GAME_ECONOMY_CONTRACT'] ?? '').toLowerCase(),
    methods: ['buyWeapon', 'upgradeWeapon'],
    description: 'Main game economy contract for weapon purchases and upgrades',
  },
  TREASURY: {
    address: (process.env['TREASURY_CONTRACT'] ?? '').toLowerCase(),
    methods: ['deposit'],
    description: 'Treasury contract for depositing funds',
  },
};

/**
 * Checks if a given contract address and method are whitelisted.
 * Both address and method must match.
 */
export function isContractWhitelisted(contractAddress: string, method: string): boolean {
  const normalizedAddress = contractAddress.toLowerCase();
  return Object.values(CONTRACT_WHITELIST).some(
    (entry) => entry.address === normalizedAddress && entry.methods.includes(method)
  );
}

/**
 * Validates that all whitelist addresses are configured (not empty strings).
 * Called at startup.
 */
export function validateWhitelist(): void {
  const missing: string[] = [];
  for (const [key, entry] of Object.entries(CONTRACT_WHITELIST)) {
    if (!entry.address || entry.address.trim() === '') {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Contract whitelist is missing addresses for: ${missing.join(', ')}. ` +
        'Check GAME_ECONOMY_CONTRACT and TREASURY_CONTRACT environment variables.'
    );
  }
}

/**
 * Maps transaction type to the target contract and ABI method.
 */
export const TX_TYPE_TO_CONTRACT: Record<string, { contractKey: string; method: string }> = {
  BUY_WEAPON: { contractKey: 'GAME_ECONOMY', method: 'buyWeapon' },
  UPGRADE_WEAPON: { contractKey: 'GAME_ECONOMY', method: 'upgradeWeapon' },
  TREASURY_DEPOSIT: { contractKey: 'TREASURY', method: 'deposit' },
};
