import { Token } from "@shared/schema";
import { Contract } from "ethers";
import { ACH_TOKEN_FACTORY_ABI, FACTORY_ADDRESS } from "@/lib/factory-abi";
import { createAlchemyProvider } from "@/lib/config";
import { getTokenLogoUrl } from "@/lib/token-logo";

export interface CommunityToken extends Token {
  community: true;
  nativeAdded: string; // formatted USDC
}

type CommunityCacheEntry = { tokens: CommunityToken[]; ts: number };

const COMMUNITY_FULL_CACHE_TTL = 5 * 60 * 1000; // 5 min
const COMMUNITY_SEED_CACHE_TTL = 30 * 60 * 1000; // 30 min
const communityCache = new Map<number, CommunityCacheEntry>();
const communityInFlight = new Map<number, Promise<CommunityToken[]>>();
const communitySeedCache = new Map<number, CommunityCacheEntry>();
const COMMUNITY_CACHE_STORAGE_PREFIX = "achswap_community_tokens_v1:";
const COMMUNITY_SEED_STORAGE_PREFIX = "achswap_community_seed_v1:";

function getCommunityCacheStorageKey(chainId: number): string {
  return `${COMMUNITY_CACHE_STORAGE_PREFIX}${chainId}`;
}

function getCommunitySeedStorageKey(chainId: number): string {
  return `${COMMUNITY_SEED_STORAGE_PREFIX}${chainId}`;
}

function normalizeCommunityTokenLogo(token: CommunityToken): CommunityToken {
  return {
    ...token,
    logoURI: getTokenLogoUrl(token.logoURI),
  };
}

function readPersistedCommunityCache(
  chainId: number,
  storageKey: string,
  ttlMs: number,
  targetCache: Map<number, CommunityCacheEntry>,
): CommunityToken[] | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { tokens?: CommunityToken[]; ts?: number };
    if (!parsed || !Array.isArray(parsed.tokens) || !Number.isFinite(parsed.ts)) return null;
    if (Date.now() - Number(parsed.ts) >= ttlMs) return null;

    const normalizedTokens = parsed.tokens.map(normalizeCommunityTokenLogo);
    targetCache.set(chainId, { tokens: normalizedTokens, ts: Number(parsed.ts) });
    return normalizedTokens;
  } catch {
    return null;
  }
}

function persistCommunityCache(storageKey: string, tokens: CommunityToken[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ tokens, ts: Date.now() }),
    );
  } catch {
    // Ignore storage quota and serialization issues.
  }
}

function formatCommunityNativeAdded(raw: unknown): string {
  try {
    const asBigInt = typeof raw === "bigint" ? raw : BigInt(String(raw ?? 0));
    const asNumber = Number(asBigInt);
    if (!Number.isFinite(asNumber)) return "0";
    return parseFloat((asNumber / 1e18).toFixed(2)).toString();
  } catch {
    return "0";
  }
}

function createCommunityToken(info: any, nativeAddedSource: unknown): CommunityToken {
  return {
    address: info.tokenAddress,
    name: info.name || info.symbol || `Token …${String(info.tokenAddress || "").slice(-4)}`,
    symbol: info.symbol || `${String(info.tokenAddress || "").slice(0, 6)}…${String(info.tokenAddress || "").slice(-4)}`,
    decimals: 18,
    logoURI: getTokenLogoUrl(info.logoUrl),
    verified: false,
    chainId: 5042002,
    community: true,
    nativeAdded: formatCommunityNativeAdded(nativeAddedSource),
  };
}

export async function fetchCommunityTokens(chainId: number): Promise<CommunityToken[]> {
  // Only on Arc testnet
  if (chainId !== 5042002) return [];

  // Use cache if fresh
  const cached = communityCache.get(chainId);
  if (cached && Date.now() - cached.ts < COMMUNITY_FULL_CACHE_TTL) {
    return cached.tokens;
  }

  const persisted = readPersistedCommunityCache(
    chainId,
    getCommunityCacheStorageKey(chainId),
    COMMUNITY_FULL_CACHE_TTL,
    communityCache,
  );
  if (persisted) {
    return persisted;
  }

  const inFlight = communityInFlight.get(chainId);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    // Use the batch provider for better performance
    const provider = createAlchemyProvider(chainId);
    const factory = new Contract(FACTORY_ADDRESS, ACH_TOKEN_FACTORY_ABI, provider);

    const [infos, liquidities] = await factory.getAllTokensLiquidity();

    const result: CommunityToken[] = [];
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      const liq = liquidities[i];
      if (!liq.hasEnoughLiquidity) continue; // ≥500 USDC threshold

      result.push(createCommunityToken(info, liq.nativeReserve));
    }

    const normalizedResult = result.map(normalizeCommunityTokenLogo);
    communityCache.set(chainId, { tokens: normalizedResult, ts: Date.now() });
    persistCommunityCache(getCommunityCacheStorageKey(chainId), normalizedResult);
    communitySeedCache.set(chainId, { tokens: normalizedResult, ts: Date.now() });
    persistCommunityCache(getCommunitySeedStorageKey(chainId), normalizedResult);
    return normalizedResult;
  })().finally(() => {
      communityInFlight.delete(chainId);
    });

  communityInFlight.set(chainId, request);
  return request;
}

export function getCachedCommunityTokens(chainId: number): CommunityToken[] | null {
  const cached = communityCache.get(chainId);
  if (cached && Date.now() - cached.ts < COMMUNITY_FULL_CACHE_TTL) {
    return cached.tokens;
  }

  return readPersistedCommunityCache(
    chainId,
    getCommunityCacheStorageKey(chainId),
    COMMUNITY_FULL_CACHE_TTL,
    communityCache,
  );
}

export async function fetchCommunityTokenSeed(chainId: number): Promise<CommunityToken[]> {
  if (chainId !== 5042002) return [];

  const fullCached = getCachedCommunityTokens(chainId);
  if (fullCached) {
    return fullCached;
  }

  const cached = communitySeedCache.get(chainId);
  if (cached && Date.now() - cached.ts < COMMUNITY_SEED_CACHE_TTL) {
    return cached.tokens;
  }

  const persisted = readPersistedCommunityCache(
    chainId,
    getCommunitySeedStorageKey(chainId),
    COMMUNITY_SEED_CACHE_TTL,
    communitySeedCache,
  );
  if (persisted) {
    return persisted;
  }

  return fetchCommunityTokens(chainId);
}

export function getCachedCommunityTokenSeed(chainId: number): CommunityToken[] | null {
  const fullCached = getCachedCommunityTokens(chainId);
  if (fullCached) {
    return fullCached;
  }

  const cached = communitySeedCache.get(chainId);
  if (cached && Date.now() - cached.ts < COMMUNITY_SEED_CACHE_TTL) {
    return cached.tokens;
  }

  return readPersistedCommunityCache(
    chainId,
    getCommunitySeedStorageKey(chainId),
    COMMUNITY_SEED_CACHE_TTL,
    communitySeedCache,
  );
}

export function preloadCommunityTokens(chainId: number): Promise<CommunityToken[]> {
  return fetchCommunityTokenSeed(chainId).then((seed) => {
    void fetchCommunityTokens(chainId).catch(() => {
      // Full liquidity refresh is best-effort; seed is enough for bootstrap.
    });
    return seed;
  });
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
    address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    name: "EURC",
    symbol: "EURC",
    decimals: 6,
    logoURI: "/img/eurc.png",
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
     logoURI: "/img/logos/aapl.png",
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
   // ── New RWA Synth Tokens ────────────────────────────────────────────────
   {
     address: "0x4fb69F9521b84be62da5dEC21E5e93D8e3fE6204",
     name: "Synth Microsoft Corp.",
     symbol: "sMSFT",
     decimals: 18,
      logoURI: "/img/logos/msft.png",
     verified: true,
     chainId: 5042002,
     rwa: true,
     rwaPairId: 6,
     rwaCategory: "Stock",
   },
   {
     address: "0xf1f19cE22Fb971a61B12F9494D100E72F9C3956E",
     name: "Synth Tesla Inc.",
     symbol: "sTSLA",
     decimals: 18,
      logoURI: "/img/logos/tsla.jpeg",
     verified: true,
     chainId: 5042002,
     rwa: true,
     rwaPairId: 7,
     rwaCategory: "Stock",
   },
   {
     address: "0x83C4571fDeB1e22975d3769EAE0bb713Bdd33452",
     name: "Synth Natural Gas",
     symbol: "sNATGAS",
     decimals: 18,
     logoURI: "/img/logos/rwa-natgas.svg",
     verified: true,
     chainId: 5042002,
     rwa: true,
     rwaPairId: 8,
     rwaCategory: "Commodity",
   },
   {
     address: "0x8f9A9ac6F16f4677beB730293C8E75694a458084",
     name: "Synth NVIDIA Corp.",
     symbol: "sNVDA",
     decimals: 18,
      logoURI: "/img/logos/nvda.jpeg",
     verified: true,
     chainId: 5042002,
     rwa: true,
     rwaPairId: 9,
     rwaCategory: "Stock",
   },
   {
     address: "0xAbE89F3C1b78b00703c93737BAF7E04543B5939d",
     name: "Synth GBP/USD",
     symbol: "sGBPUSD",
     decimals: 18,
      logoURI: "/img/logos/gbpusd.jpeg",
     verified: true,
     chainId: 5042002,
     rwa: true,
     rwaPairId: 10,
     rwaCategory: "Forex",
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
  const communities = await fetchCommunityTokens(chainId).catch(() => []);
  // combine, ensuring communities don't override defaults
  const defaultsSet = new Set(defaults.map(t => t.address.toLowerCase()));
  const filteredCommunities = communities.filter(t => !defaultsSet.has(t.address.toLowerCase()));

  const allTokens = [...defaults, ...filteredCommunities];

  // Ensure ALL tokens have their IPFS/gateway URLs properly formatted
  return allTokens.map(t => ({
    ...t,
    logoURI: getTokenLogoUrl(t.logoURI)
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

const CANONICAL_USDC_ADDRESSES: Record<number, { usdc: string; wusdc: string }> = {
  5042002: {
    usdc: "0x0000000000000000000000000000000000000000",
    wusdc: "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA",
  },
};

function normalize(addr: string): string {
  return addr.toLowerCase();
}

export function getUSDC(chainId: number): Token | undefined {
  const canonical = CANONICAL_USDC_ADDRESSES[chainId];
  if (!canonical) return undefined;
  return getTokensByChainId(chainId).find(t => normalize(t.address) === normalize(canonical.usdc));
}

export function getWUSDC(chainId: number): Token | undefined {
  const canonical = CANONICAL_USDC_ADDRESSES[chainId];
  if (!canonical) return undefined;
  return getTokensByChainId(chainId).find(t => normalize(t.address) === normalize(canonical.wusdc));
}

export function isCanonicalUSDC(token: Token | null | undefined): boolean {
  if (!token) return false;
  const canonical = CANONICAL_USDC_ADDRESSES[token.chainId];
  if (!canonical) return false;
  return normalize(token.address) === normalize(canonical.usdc);
}

export function isCanonicalWUSDC(token: Token | null | undefined): boolean {
  if (!token) return false;
  const canonical = CANONICAL_USDC_ADDRESSES[token.chainId];
  if (!canonical) return false;
  return normalize(token.address) === normalize(canonical.wusdc);
}

export function isRWASwapPair(from: Token | null, to: Token | null): boolean {
  if (!from || !to) return false;
  const fromIsRWA = isRWAToken(from);
  const toIsRWA = isRWAToken(to);
  const fromIsUSDC = isCanonicalUSDC(from);
  const toIsUSDC = isCanonicalUSDC(to);
  return (fromIsRWA && toIsUSDC) || (fromIsUSDC && toIsRWA);
}
