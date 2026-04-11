const STUDIO_URL = "https://api.studio.thegraph.com/query/1742338/ach/version/latest";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((v) => normalizeOrigin(v))
  .filter(Boolean);
const SUBGRAPH_PROXY_TOKEN = (process.env.SUBGRAPH_PROXY_TOKEN || "").trim();
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 180;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5_000;
const DEFAULT_SUMMARY_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_RANK_CACHE_ENTRIES = 1000;

function readPositiveEnvNumber(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.warn(`[analytics-summary] Invalid ${name}=${raw}; using default ${fallback}`);
    return fallback;
  }

  return parsed;
}

const RATE_LIMIT_MAX = readPositiveEnvNumber("SUBGRAPH_RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT_MAX, 1, 100_000);
const UPSTREAM_TIMEOUT_MS = readPositiveEnvNumber("UPSTREAM_TIMEOUT_MS", DEFAULT_UPSTREAM_TIMEOUT_MS, 250, 120_000);
const SUMMARY_CACHE_TTL_MS = readPositiveEnvNumber("ANALYTICS_SUMMARY_CACHE_TTL_MS", DEFAULT_SUMMARY_CACHE_TTL_MS, 1_000, 3_600_000);
const MAX_RANK_CACHE_ENTRIES = readPositiveEnvNumber("ANALYTICS_RANK_CACHE_MAX", DEFAULT_MAX_RANK_CACHE_ENTRIES, 1, 100_000);
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const RATE_LIMIT_WINDOW_SECONDS = Math.max(1, Math.floor(RATE_LIMIT_WINDOW_MS / 1000));

const rateLimitByKey = new Map();
let rateLimitRequestCount = 0;
const summaryCache = {
  value: null,
  expiresAt: 0,
};
const rankCache = new Map();
let summaryRefreshPromise = null;
const rankRefreshPromises = new Map();

function normalizeOrigin(origin) {
  if (!origin) return "";
  const trimmed = String(origin).trim();

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "";

    const hostname = parsed.hostname.toLowerCase();
    const defaultPort = (protocol === "http:" && (parsed.port === "" || parsed.port === "80"))
      || (protocol === "https:" && (parsed.port === "" || parsed.port === "443"));
    const portPart = defaultPort ? "" : `:${parsed.port}`;

    return `${protocol}//${hostname}${portPart}`;
  } catch {
    return "";
  }
}

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.length === 0) return false;
  const normalized = normalizeOrigin(origin);
  return ALLOWED_ORIGINS.includes(normalized);
}

function sameOrigin(req) {
  const originHeader = req.headers.origin;
  if (!originHeader) return false;

  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();
  if (!host) return false;

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:$/, "");

  const normalizedHost = host
    .replace(/:443$/i, proto === "https" ? "" : "$&")
    .replace(/:80$/i, proto === "http" ? "" : "$&");
  const serverOrigin = `${proto}://${normalizedHost}`.toLowerCase();
  try {
    return new URL(originHeader).origin.toLowerCase() === serverOrigin;
  } catch {
    return false;
  }
}

function isAllowedBrowserOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (sameOrigin(req)) return true;
  if (ALLOWED_ORIGINS.length === 0) return false;
  return isOriginAllowed(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedBrowserOrigin(req)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-App-Token, Authorization");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function isAuthorized(req) {
  if (!SUBGRAPH_PROXY_TOKEN) return false;
  const appHeader = req.headers["x-app-token"];
  const authHeader = req.headers.authorization;
  const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";
  return appHeader === SUBGRAPH_PROXY_TOKEN || bearer === SUBGRAPH_PROXY_TOKEN;
}

function isPrivileged(req) {
  return isAuthorized(req);
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const json = await response.json();
    return { response, json };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function incrementSharedRateLimit(key) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;

  const pipelineUrl = `${UPSTASH_REDIS_REST_URL.replace(/\/$/, "")}/pipeline`;
  const payload = [
    ["INCR", key],
    ["EXPIRE", key, String(RATE_LIMIT_WINDOW_SECONDS), "NX"],
  ];

  const { response, json } = await fetchJsonWithTimeout(
    pipelineUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    1500,
  );

  if (!response.ok) {
    throw new Error(`Shared rate-limit store error ${response.status}`);
  }

  const incrementResult = Array.isArray(json) ? json[0]?.result : null;
  const incrementCount = Number(incrementResult);
  if (!Number.isFinite(incrementCount)) {
    throw new Error("Shared rate-limit store returned invalid counter");
  }

  return incrementCount;
}

function pruneRateLimitBuckets(now) {
  for (const [key, state] of rateLimitByKey) {
    if (!state || typeof state.resetAt !== "number" || state.resetAt <= now) {
      rateLimitByKey.delete(key);
    }
  }
}

async function checkRateLimit(req) {
  const authIdentity = req.auth?.appId || req.user?.id || "anon";
  const key = `${getClientIp(req)}:${authIdentity}`;
  const now = Date.now();

  try {
    const sharedCount = await incrementSharedRateLimit(`analytics-summary:rl:${key}`);
    if (typeof sharedCount === "number") {
      return sharedCount <= RATE_LIMIT_MAX;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[analytics-summary] shared rate-limit unavailable, using in-memory fallback: ${detail}`);
  }

  rateLimitRequestCount += 1;
  if (rateLimitRequestCount % 64 === 0) {
    pruneRateLimitBuckets(now);
  }

  const state = rateLimitByKey.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  state.count += 1;
  rateLimitByKey.set(key, state);
  return state.count <= RATE_LIMIT_MAX;
}

function getCachedSummaryState() {
  if (!summaryCache.value) {
    return { value: null, fresh: false };
  }

  return {
    value: summaryCache.value,
    fresh: Date.now() <= summaryCache.expiresAt,
  };
}

function setCachedSummary(value) {
  summaryCache.value = value;
  summaryCache.expiresAt = Date.now() + SUMMARY_CACHE_TTL_MS;
}

function getCachedRankState(wallet) {
  const cached = rankCache.get(wallet);
  if (!cached) {
    return { exists: false, value: null, fresh: false };
  }

  return {
    exists: true,
    value: cached.value,
    fresh: Date.now() <= cached.expiresAt,
  };
}

function setCachedRank(wallet, rank) {
  rankCache.set(wallet, {
    value: rank,
    expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
  });

  if (rankCache.size > MAX_RANK_CACHE_ENTRIES) {
    const oldest = rankCache.keys().next().value;
    if (oldest) rankCache.delete(oldest);
  }
}

async function fetchSubgraph(token, query, variables) {
  return fetchJsonWithTimeout(
    STUDIO_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    },
    UPSTREAM_TIMEOUT_MS,
  );
}

function normalizeAddressInput(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : "";
}

async function countEntityByPagination(token, entity, where = "") {
  let total = 0;
  let skip = 0;

  while (true) {
    const filter = where ? `, where: ${where}` : "";
    const query = `query Count${entity}${skip} { ${entity}(first: 1000, skip: ${skip}${filter}) { id } }`;
    const { response: upstream, json: payload } = await fetchSubgraph(token, query, {});

    if (!upstream.ok) {
      throw new Error(payload?.errors?.[0]?.message || `Upstream ${entity} count failed`);
    }
    if (payload?.errors?.length) {
      throw new Error(payload.errors[0]?.message || `${entity} count query failed`);
    }

    const rows = payload?.data?.[entity] || [];
    total += rows.length;
    if (rows.length < 1000) break;
    skip += 1000;
  }

  return total;
}

async function buildAggregateSummary(token) {
  const [totalUsersCount, swapUsersCount, rwaUsersCount, outlierPoolsCount] = await Promise.all([
    countEntityByPagination(token, "users"),
    countEntityByPagination(token, "users", "{ swapCount_gt: 0 }"),
    countEntityByPagination(token, "users", "{ or: [{ rwaBuyCount_gt: 0 }, { rwaRedeemCount_gt: 0 }] }"),
    countEntityByPagination(token, "pools", "{ flaggedLowLiquidityOutlier: true }"),
  ]);

  return {
    totalUsersCount,
    swapUsersCount,
    rwaUsersCount,
    outlierPoolsCount,
  };
}

function triggerSummaryRefresh(token) {
  if (summaryRefreshPromise) return summaryRefreshPromise;

  summaryRefreshPromise = buildAggregateSummary(token)
    .then((summary) => {
      setCachedSummary(summary);
      return summary;
    })
    .catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[analytics-summary] summary refresh failed: ${detail}`);
      throw err;
    })
    .finally(() => {
      summaryRefreshPromise = null;
    });

  return summaryRefreshPromise;
}

async function getUserRankByEffectiveVolume(token, wallet) {
  if (!wallet) return null;

  const targetQuery = `
    query TargetUserRank($wallet: String!) {
      target: user(id: $wallet) {
        id
        totalEffectiveVolumeUsd
      }
    }
  `;
  const { response: targetResponse, json: targetPayload } = await fetchSubgraph(token, targetQuery, { wallet });

  if (!targetResponse.ok) {
    throw new Error(targetPayload?.errors?.[0]?.message || "Upstream target rank query failed");
  }
  if (targetPayload?.errors?.length) {
    throw new Error(targetPayload.errors[0]?.message || "Target rank query failed");
  }

  const target = targetPayload?.data?.target;
  if (!target?.id) return null;

  const targetVolume = String(target.totalEffectiveVolumeUsd ?? "0");

  const encodedTargetVolume = JSON.stringify(targetVolume);
  const encodedWallet = JSON.stringify(wallet);

  const higherCount = await countEntityByPagination(
    token,
    "users",
    `{ totalEffectiveVolumeUsd_gt: ${encodedTargetVolume} }`,
  );

  const tiedLowerCount = await countEntityByPagination(
    token,
    "users",
    `{ totalEffectiveVolumeUsd: ${encodedTargetVolume}, id_lt: ${encodedWallet} }`,
  );

  return higherCount + tiedLowerCount + 1;
}

function triggerRankRefresh(token, wallet) {
  const existing = rankRefreshPromises.get(wallet);
  if (existing) return existing;

  const refresh = getUserRankByEffectiveVolume(token, wallet)
    .then((rank) => {
      setCachedRank(wallet, rank);
      return rank;
    })
    .catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      const maskedWallet = typeof wallet === "string" && wallet.length > 10
        ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
        : "<redacted>";
      console.warn(`[analytics-summary] rank refresh failed for ${maskedWallet}: ${detail}`);
      throw err;
    })
    .finally(() => {
      rankRefreshPromises.delete(wallet);
    });

  rankRefreshPromises.set(wallet, refresh);
  return refresh;
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    if (req.headers.origin && !isAllowedBrowserOrigin(req)) return res.status(403).json({ error: "Origin not allowed" });
    return res.status(200).end();
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (req.headers.origin && !isAllowedBrowserOrigin(req)) return res.status(403).json({ error: "Origin not allowed" });
  const trustedSameOrigin = sameOrigin(req);
  const trustedBrowserOrigin = isAllowedBrowserOrigin(req);
  if (!trustedSameOrigin && !trustedBrowserOrigin) {
    if (!SUBGRAPH_PROXY_TOKEN) return res.status(500).json({ error: "Missing SUBGRAPH_PROXY_TOKEN server environment variable" });
    if (!isAuthorized(req)) return res.status(403).json({ error: "Unauthorized" });
  }
  if (!(await checkRateLimit(req))) return res.status(429).json({ error: "Rate limit exceeded" });

  const token = process.env.GRAPH_QUERY_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "Missing GRAPH_QUERY_TOKEN server environment variable" });
  }

  const wallet = normalizeAddressInput(req.body?.wallet || "");
  const forceRefresh = req.body?.forceRefresh === true && isPrivileged(req);

  try {
    const summaryState = forceRefresh
      ? { value: null, fresh: false }
      : getCachedSummaryState();

    let aggregateSummary = summaryState.value;
    if (!aggregateSummary) {
      try {
        aggregateSummary = await triggerSummaryRefresh(token);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return res.status(503).json({ error: `Analytics summary refresh failed: ${detail}` });
      }
    } else if (!summaryState.fresh || forceRefresh) {
      void triggerSummaryRefresh(token).catch(() => {});
    }

    if (!aggregateSummary) {
      return res.status(503).json({ error: "Analytics summary is warming up. Please retry shortly." });
    }

    let targetUserRank = null;
    if (wallet) {
      const rankState = forceRefresh
        ? { exists: false, value: null, fresh: false }
        : getCachedRankState(wallet);

      if (!rankState.exists) {
        try {
          targetUserRank = await triggerRankRefresh(token, wallet);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return res.status(503).json({ error: `Analytics rank refresh failed: ${detail}` });
        }
      } else {
        targetUserRank = rankState.value;
        if (!rankState.fresh || forceRefresh) {
          void triggerRankRefresh(token, wallet).catch(() => {});
        }
      }
    }

    return res.status(200).json({
      totalUsersCount: aggregateSummary.totalUsersCount,
      swapUsersCount: aggregateSummary.swapUsersCount,
      rwaUsersCount: aggregateSummary.rwaUsersCount,
      outlierPoolsCount: aggregateSummary.outlierPoolsCount,
      targetUserRank,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return res.status(504).json({ error: "Subgraph upstream timeout" });
    }
    const message = err instanceof Error ? err.message : "Unknown analytics summary error";
    return res.status(502).json({ error: message });
  }
}
