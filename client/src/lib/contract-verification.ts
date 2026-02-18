import { BrowserProvider } from "ethers";

/**
 * Check if contract exists at address
 */
export async function contractExists(provider: BrowserProvider, address: string): Promise<boolean> {
  try {
    const code = await provider.getCode(address);
    return code !== "0x" && code !== "0x0";
  } catch (error) {
    console.error(`Error checking contract at ${address}:`, error);
    return false;
  }
}

/**
 * Verify all V3 contracts exist
 */
export async function verifyV3Contracts(
  provider: BrowserProvider,
  contracts: {
    factory: string;
    swapRouter: string;
    nonfungiblePositionManager: string;
    quoter02: string;
    migrator: string;
  }
): Promise<{ exists: boolean; missing: string[]; details: Record<string, boolean> }> {
  const contractEntries = Object.entries(contracts);
  const results = await Promise.allSettled(
    contractEntries.map(([_, address]) => contractExists(provider, address))
  );

  const details: Record<string, boolean> = {};
  const missing: string[] = [];

  contractEntries.forEach(([name, address], index) => {
    const result = results[index];
    const exists = result.status === "fulfilled" && result.value === true;
    details[name] = exists;
    
    if (!exists) {
      missing.push(`${name} (${address})`);
    }
  });

  return {
    exists: missing.length === 0,
    missing,
    details,
  };
}
