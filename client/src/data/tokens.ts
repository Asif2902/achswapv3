import { Token } from "@shared/schema";
import { Contract, JsonRpcProvider } from "ethers";
import { ACH_TOKEN_FACTORY_ABI, FACTORY_ADDRESS } from "@/lib/factory-abi";
import { createAlchemyProvider } from "@/lib/config";

export interface CommunityToken extends Token {
  community: true;
  nativeAdded: string; // formatted USDC
}

const COMMUNITY_CACHE_TTL = 5 * 60 * 1000; // 5 min
let _communityCache: { tokens: CommunityToken[]; ts: number } | null = null;

// Ensure gateway URL is consistent with LaunchToken
function getGatewayUrlFromCid(cidOrUrl: string): string {
  if (!cidOrUrl) return "/img/logos/unknown-token.png";
  // Handle local paths (already in correct format)
  if (cidOrUrl.startsWith("/img/") || cidOrUrl.startsWith("data:")) return cidOrUrl;
  if (cidOrUrl.startsWith("http")) return cidOrUrl;
  if (cidOrUrl.startsWith("ipfs://")) {
    return cidOrUrl.replace("ipfs://", "https://gateway.pinata.cloud/ipfs/");
  }
  // Handle direct CID without protocol
  return `https://gateway.pinata.cloud/ipfs/${cidOrUrl}`;
}

export async function fetchCommunityTokens(chainId: number): Promise<CommunityToken[]> {
  // Only on Arc testnet
  if (chainId !== 5042002) return [];

  // Use cache if fresh
  if (_communityCache && Date.now() - _communityCache.ts < COMMUNITY_CACHE_TTL) {
    return _communityCache.tokens;
  }

  try {
    // Use the batch provider for better performance
    const provider = createAlchemyProvider(chainId);
    const factory = new Contract(FACTORY_ADDRESS, ACH_TOKEN_FACTORY_ABI, provider);

    const [infos, liquidities] = await factory.getAllTokensLiquidity();

    const result: CommunityToken[] = [];
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      const liq = liquidities[i];
      if (!liq.hasEnoughLiquidity) continue; // ≥500 USDC threshold

      result.push({
        address: info.tokenAddress,
        name: info.name || info.symbol || `Token …${info.tokenAddress.slice(-4)}`,
        symbol: info.symbol || `${info.tokenAddress.slice(0, 6)}…${info.tokenAddress.slice(-4)}`,
        decimals: 18,
        logoURI: info.logoUrl ? getGatewayUrlFromCid(info.logoUrl) : "/img/logos/unknown-token.png",
        verified: false,
        chainId: 5042002,
        community: true,
        nativeAdded: parseFloat(
          (Number(liq.nativeReserve) / 1e18).toFixed(2)
        ).toString(),
      });
    }

    _communityCache = { tokens: result, ts: Date.now() };
    return result;
  } catch (err) {
    console.warn("[Tokens] Community fetch failed:", err);
    return [];
  }
}


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
  },
  // ── RWA Synth Tokens ───────────────────────────────────────────────────
  {
    address: "0xB7d0e4FBB6C31997aeBc8070f9BF326Bb0ef859E",
    name: "Synth Apple Inc.",
    symbol: "sAAPL",
    decimals: 18,
    logoURI: "/img/logos/rwa-aapl.svg",
    verified: true,
    chainId: 5042002,
    rwa: true,
    rwaPairId: 1,
    rwaCategory: "Stock",
  },
  {
    address: "0x22Dd732d8bf020d1Cd6D2ec3342ce43f15a982b1",
    name: "Synth Alphabet Inc.",
    symbol: "sGOOGL",
    decimals: 18,
    logoURI: "/img/logos/rwa-googl.svg",
    verified: true,
    chainId: 5042002,
    rwa: true,
    rwaPairId: 2,
    rwaCategory: "Stock",
  },
  {
    address: "0x3fEa75ABE23B1C01F00F03eb6a7a9f75d9De957e",
    name: "Synth Crude Oil WTI",
    symbol: "sWTI",
    decimals: 18,
    logoURI: "/img/logos/rwa-wti.svg",
    verified: true,
    chainId: 5042002,
    rwa: true,
    rwaPairId: 3,
    rwaCategory: "Commodity",
  },
  {
    address: "0x77643b9D8470C8959B92651F57cEcA08D770b89c",
    name: "Synth Gold",
    symbol: "sGOLD",
    decimals: 18,
    logoURI: "/img/logos/rwa-gold.svg",
    verified: true,
    chainId: 5042002,
    rwa: true,
    rwaPairId: 4,
    rwaCategory: "Commodity",
  },
  {
    address: "0x80Ca3b18F75702B0626Eb7441aCaA33a8e24100d",
    name: "Synth Silver",
    symbol: "sSILVER",
    decimals: 18,
    logoURI: "/img/logos/rwa-silver.svg",
    verified: true,
    chainId: 5042002,
    rwa: true,
    rwaPairId: 5,
    rwaCategory: "Commodity",
  },
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

export async function fetchTokensWithCommunity(chainId: number): Promise<Token[]> {
  const defaults = getTokensByChainId(chainId);
  const communities = await fetchCommunityTokens(chainId);
  // combine, ensuring communities don't override defaults
  const defaultsSet = new Set(defaults.map(t => t.address.toLowerCase()));
  const filteredCommunities = communities.filter(t => !defaultsSet.has(t.address.toLowerCase()));

  const allTokens = [...defaults, ...filteredCommunities];

  // Ensure ALL tokens have their IPFS/gateway URLs properly formatted
  return allTokens.map(t => ({
    ...t,
    logoURI: t.logoURI ? getGatewayUrlFromCid(t.logoURI) : "/img/logos/unknown-token.png"
  }));
}

// ── RWA Helpers ───────────────────────────────────────────────────────────────

export function isRWAToken(token: Token | null | undefined): boolean {
  return !!token?.rwa;
}

export function getRWATokens(chainId: number): Token[] {
  return getTokensByChainId(chainId).filter(t => t.rwa === true);
}

export function getNonRWATokens(chainId: number): Token[] {
  return getTokensByChainId(chainId).filter(t => !t.rwa);
}

export function getUSDC(chainId: number): Token | undefined {
  return getTokensByChainId(chainId).find(t => t.symbol === "USDC");
}

const USDC_ADDRESS = "0x0000000000000000000000000000000000000000";
const WUSDC_ADDRESS = "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA";

function normalize(addr: string): string {
  return addr.toLowerCase();
}

export function isCanonicalUSDC(token: Token | null | undefined): boolean {
  if (!token) return false;
  const a = normalize(token.address);
  return a === normalize(USDC_ADDRESS);
}

export function isCanonicalWUSDC(token: Token | null | undefined): boolean {
  if (!token) return false;
  const a = normalize(token.address);
  return a === normalize(WUSDC_ADDRESS);
}

export function isRWASwapPair(from: Token | null, to: Token | null): boolean {
  if (!from || !to) return false;
  const fromIsRWA = isRWAToken(from);
  const toIsRWA = isRWAToken(to);
  const fromIsUSDC = isCanonicalUSDC(from);
  const toIsUSDC = isCanonicalUSDC(to);
  return (fromIsRWA && toIsUSDC) || (fromIsUSDC && toIsRWA);
}
