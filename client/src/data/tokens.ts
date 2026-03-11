import { Token } from "@shared/schema";
import { Contract, JsonRpcProvider } from "ethers";
import { ACH_TOKEN_FACTORY_ABI, FACTORY_ADDRESS } from "@/lib/factory-abi";

export interface CommunityToken extends Token {
  community: true;
  nativeAdded: string; // formatted USDC
}

const COMMUNITY_CACHE_TTL = 5 * 60 * 1000; // 5 min
let _communityCache: { tokens: CommunityToken[]; ts: number } | null = null;

// Ensure gateway URL is consistent, mimicking that of LaunchToken
function getGatewayUrlFromCid(cidOrUrl: string): string {
  if (!cidOrUrl) return "";
  if (cidOrUrl.startsWith("http")) return cidOrUrl;
  const match = cidOrUrl.match(/ipfs:\/\/([^/]+)(?:\/(.*))?/);
  if (match) {
    return `https://${match[1]}.ipfs.w3s.link${match[2] ? `/${match[2]}` : ""}`;
  }
  return `https://${cidOrUrl}.ipfs.w3s.link`;
}

export async function fetchCommunityTokens(chainId: number): Promise<CommunityToken[]> {
  // Only on Arc testnet
  if (chainId !== 5042002) return [];

  // Use cache if fresh
  if (_communityCache && Date.now() - _communityCache.ts < COMMUNITY_CACHE_TTL) {
    return _communityCache.tokens;
  }

  try {
    const provider = new JsonRpcProvider("https://rpc.testnet.arc.network");
    const factory = new Contract(FACTORY_ADDRESS, ACH_TOKEN_FACTORY_ABI, provider);

    const [infos, liquidities] = await factory.getAllTokensLiquidity();

    const result: CommunityToken[] = [];
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      const liq = liquidities[i];
      if (!liq.hasEnoughLiquidity) continue; // ≥500 USDC threshold

      result.push({
        address: info.tokenAddress,
        name: info.name,
        symbol: info.symbol,
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

export async function fetchTokensWithCommunity(chainId: number): Promise<Token[]> {
  const defaults = getTokensByChainId(chainId);
  const communities = await fetchCommunityTokens(chainId);
  // combine, ensuring communities don't override defaults
  const defaultsSet = new Set(defaults.map(t => t.address.toLowerCase()));
  const filteredCommunities = communities.filter(t => !defaultsSet.has(t.address.toLowerCase()));

  return [...defaults, ...filteredCommunities];
}
