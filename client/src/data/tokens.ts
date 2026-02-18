import { Token } from "@shared/schema";

// ARC Testnet tokens (Chain ID: 5042002)
const arcTestnetTokens: Token[] = [
  {
    address: "0x0000000000000000000000000000000000000000",
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
    logoURI: "/img/usdc.webp",
    verified: true,
    chainId: 5042002
  },
  {
    address: "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA",
    name: "Wrapped USDC",
    symbol: "wUSDC",
    decimals: 18,
    logoURI: "/img/logos/wusdc.png",
    verified: true,
    chainId: 5042002
  },
  {
    address: "0x45Bb5425f293bdd209c894364C462421FF5FfA48",
    name: "Achswap Token",
    symbol: "ACHS",
    decimals: 18,
    logoURI: "/img/logos/achs-token.png",
    verified: true,
    chainId: 5042002
  }
];

// Wrapped token mappings: native -> wrapped address
// Note: Keys are stored in lowercase for consistent lookup
export const wrappedTokenMap: Record<number, Record<string, string>> = {
  5042002: {
    // USDC (native/zero address) -> wUSDC
    "0x0000000000000000000000000000000000000000": "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA",
  },
};

// Reverse mapping: wrapped -> native
// Note: Keys are stored in lowercase for consistent lookup
export const unwrappedTokenMap: Record<number, Record<string, string>> = {
  5042002: {
    "0xde5db9049a8dd344dc1b7bbb098f9da60930a6da": "0x0000000000000000000000000000000000000000",
  },
};

export function getWrappedAddress(chainId: number, tokenAddress: string): string | null {
  const map = wrappedTokenMap[chainId];
  if (!map) return null;
  // Always use lowercase for lookup to ensure consistency
  return map[tokenAddress.toLowerCase()] || null;
}

export function getUnwrappedAddress(chainId: number, tokenAddress: string): string | null {
  const map = unwrappedTokenMap[chainId];
  if (!map) return null;
  // Always use lowercase for lookup to ensure consistency
  return map[tokenAddress.toLowerCase()] || null;
}

export function isNativeToken(tokenAddress: string): boolean {
  return tokenAddress === "0x0000000000000000000000000000000000000000";
}

export function isWrappedToken(chainId: number, tokenAddress: string): boolean {
  const map = unwrappedTokenMap[chainId];
  if (!map) return false;
  return !!map[tokenAddress.toLowerCase()] || !!map[tokenAddress];
}

// To add more chains: create token arrays for each chain and add them to tokensByChainId
const tokensByChainId: Record<number, Token[]> = {
  5042002: arcTestnetTokens,
  // Add more chains here, e.g.:
  // 1: mainnetTokens,
  // 137: polygonTokens,
};

export const defaultTokens: Token[] = Object.values(tokensByChainId).flat();

export function getTokensByChainId(chainId: number): Token[] {
  return tokensByChainId[chainId] || [];
}
