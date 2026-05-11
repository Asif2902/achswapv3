import { Contract, JsonRpcProvider } from "ethers";

const ARC_TESTNET_CHAIN_ID = 5042002;
const PUBLIC_ARC_RPC = "https://rpc.testnet.arc.network";
const FACTORY_ADDRESS = "0x9Fc1dE24b1E9bB64E415b29aF12b7931F37F335D";
const COMMUNITY_CACHE_CONTROL = "public, max-age=30, s-maxage=60, stale-while-revalidate=300";
const FRESH_CACHE_TTL_MS = 45 * 1000;
const STALE_CACHE_TTL_MS = 15 * 60 * 1000;
const ALCHEMY_TIMEOUT_MS = 2500;
const PUBLIC_TIMEOUT_MS = 3200;

const COMMUNITY_FACTORY_ABI = [
  "function getAllTokensLiquidity() external view returns (tuple(address tokenAddress, address pairAddress, address owner, string name, string symbol, uint256 totalSupply, uint256 ownerTokens, string logoUrl, uint256 liquidityPercent, uint256 nativeAdded, uint256 createdAt)[], tuple(address pairAddress, uint256 tokenReserve, uint256 nativeReserve, bool hasEnoughLiquidity)[])",
];

const communityCache = new Map();

function getRpcUrls() {
  const primaryAlchemyKey = process.env.VITE_ALCHEMY_KEY || process.env.ALCHEMY_KEY;
  const backupAlchemyKey = process.env.VITE_ALCHEMY_BACKUP_KEY || process.env.ALCHEMY_BACKUP_KEY;
  const urls = [
    primaryAlchemyKey ? `https://arc-testnet.g.alchemy.com/v2/${primaryAlchemyKey}` : null,
    backupAlchemyKey ? `https://arc-testnet.g.alchemy.com/v2/${backupAlchemyKey}` : null,
    PUBLIC_ARC_RPC,
  ].filter(Boolean);

  return [...new Set(urls)];
}

function withTimeout(promise, ms) {
  let timeoutId;

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function formatCommunityNativeAdded(raw) {
  try {
    const asBigInt = typeof raw === "bigint" ? raw : BigInt(String(raw ?? 0));
    const asNumber = Number(asBigInt);
    if (!Number.isFinite(asNumber)) return "0";
    return parseFloat((asNumber / 1e18).toFixed(2)).toString();
  } catch {
    return "0";
  }
}

function mapCommunityTokens(infos, liquidities) {
  const result = [];

  for (let index = 0; index < infos.length; index += 1) {
    const info = infos[index];
    const liquidity = liquidities[index];
    if (!liquidity?.hasEnoughLiquidity) continue;

    result.push({
      address: info.tokenAddress,
      name: info.name || info.symbol || `Token …${String(info.tokenAddress || "").slice(-4)}`,
      symbol: info.symbol || `${String(info.tokenAddress || "").slice(0, 6)}…${String(info.tokenAddress || "").slice(-4)}`,
      decimals: 18,
      logoURI: info.logoUrl || "",
      verified: false,
      chainId: ARC_TESTNET_CHAIN_ID,
      community: true,
      nativeAdded: formatCommunityNativeAdded(liquidity.nativeReserve),
    });
  }

  return result;
}

function getFreshCache(chainId) {
  const cached = communityCache.get(chainId);
  if (!cached) return null;
  if (Date.now() - cached.ts >= FRESH_CACHE_TTL_MS) return null;
  return cached.tokens;
}

function getStaleCache(chainId) {
  const cached = communityCache.get(chainId);
  if (!cached) return null;
  if (Date.now() - cached.ts >= STALE_CACHE_TTL_MS) return null;
  return cached.tokens;
}

function setCache(chainId, tokens) {
  communityCache.set(chainId, { tokens, ts: Date.now() });
}

async function fetchCommunityTokensFromRpc(url) {
  const provider = new JsonRpcProvider(url, ARC_TESTNET_CHAIN_ID, { staticNetwork: true });
  const factory = new Contract(FACTORY_ADDRESS, COMMUNITY_FACTORY_ABI, provider);
  const timeoutMs = url === PUBLIC_ARC_RPC ? PUBLIC_TIMEOUT_MS : ALCHEMY_TIMEOUT_MS;
  const [infos, liquidities] = await withTimeout(factory.getAllTokensLiquidity(), timeoutMs);
  return mapCommunityTokens(infos, liquidities);
}

async function loadCommunityTokens(chainId) {
  let lastError = null;

  for (const url of getRpcUrls()) {
    try {
      const tokens = await fetchCommunityTokensFromRpc(url);
      setCache(chainId, tokens);
      return tokens;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Failed to load community tokens");
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "Method Not Allowed" });
  }

  const url = new URL(req.url, "http://localhost");
  const chainId = Number(url.searchParams.get("chainId") || ARC_TESTNET_CHAIN_ID);
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    return sendJson(res, 200, { tokens: [] }, { "Cache-Control": COMMUNITY_CACHE_CONTROL });
  }

  const cached = getFreshCache(chainId);
  if (cached) {
    return sendJson(res, 200, { tokens: cached }, {
      "Cache-Control": COMMUNITY_CACHE_CONTROL,
      "X-Community-Cache": "hit",
    });
  }

  try {
    const tokens = await loadCommunityTokens(chainId);
    return sendJson(res, 200, { tokens }, {
      "Cache-Control": COMMUNITY_CACHE_CONTROL,
      "X-Community-Cache": "miss",
    });
  } catch (error) {
    const stale = getStaleCache(chainId);
    if (stale) {
      return sendJson(res, 200, { tokens: stale }, {
        "Cache-Control": COMMUNITY_CACHE_CONTROL,
        "X-Community-Cache": "stale",
      });
    }

    console.error("[community-tokens] failed to load community tokens", error);
    return sendJson(res, 502, { error: "Failed to load community tokens" });
  }
}
