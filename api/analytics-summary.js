const STUDIO_URL = "https://api.studio.thegraph.com/query/1742338/ach/version/latest";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const SUBGRAPH_PROXY_TOKEN = (process.env.SUBGRAPH_PROXY_TOKEN || "").trim();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.SUBGRAPH_RATE_LIMIT_PER_MINUTE || 180);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 5_000);
const SUMMARY_CACHE_TTL_MS = Number(process.env.ANALYTICS_SUMMARY_CACHE_TTL_MS || 60_000);
const MAX_RANK_CACHE_ENTRIES = Number(process.env.ANALYTICS_RANK_CACHE_MAX || 1000);

const rateLimitByKey = new Map();
const summaryCache = {
  value: null,
  expiresAt: 0,
};
const rankCache = new Map();

function normalizeOrigin(origin) {
  if (!origin) return "";
  return origin.trim().toLowerCase();
}

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const normalized = normalizeOrigin(origin);
  return ALLOWED_ORIGINS.some((allowed) => normalizeOrigin(allowed) === normalized);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
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

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim().toLowerCase();
  if (typeof origin !== "string" || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function checkRateLimit(req) {
  const key = `${getClientIp(req)}:${req.headers["x-app-token"] || "anon"}`;
  const now = Date.now();
  const state = rateLimitByKey.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  state.count += 1;
  rateLimitByKey.set(key, state);
  return state.count <= RATE_LIMIT_MAX;
}

function getCachedSummary() {
  if (Date.now() > summaryCache.expiresAt) {
    summaryCache.value = null;
    summaryCache.expiresAt = 0;
    return null;
  }
  return summaryCache.value;
}

function setCachedSummary(value) {
  summaryCache.value = value;
  summaryCache.expiresAt = Date.now() + SUMMARY_CACHE_TTL_MS;
}

function getCachedRank(wallet) {
  const cached = rankCache.get(wallet);
  if (!cached) return undefined;
  if (Date.now() > cached.expiresAt) {
    rankCache.delete(wallet);
    return undefined;
  }
  return cached.value;
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(STUDIO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
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
    const upstream = await fetchSubgraph(token, query, {});
    const payload = await upstream.json();

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

async function getUserRankByEffectiveVolume(token, wallet) {
  if (!wallet) return null;

  let rank = 1;
  let skip = 0;

  while (true) {
    const query = `
      query RankChunk {
        users(first: 1000, skip: ${skip}, orderBy: totalEffectiveVolumeUsd, orderDirection: desc) {
          id
        }
      }
    `;
    const upstream = await fetchSubgraph(token, query, {});
    const payload = await upstream.json();

    if (!upstream.ok) {
      throw new Error(payload?.errors?.[0]?.message || "Upstream rank query failed");
    }
    if (payload?.errors?.length) {
      throw new Error(payload.errors[0]?.message || "Rank query failed");
    }

    const users = payload?.data?.users || [];
    if (!users.length) return null;

    const foundIndex = users.findIndex((u) => String(u.id || "").toLowerCase() === wallet);
    if (foundIndex >= 0) return rank + foundIndex;

    rank += users.length;
    if (users.length < 1000) return null;
    skip += 1000;
  }
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    if (!isOriginAllowed(req.headers.origin)) return res.status(403).json({ error: "Origin not allowed" });
    return res.status(200).end();
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isOriginAllowed(req.headers.origin)) return res.status(403).json({ error: "Origin not allowed" });
  if (!SUBGRAPH_PROXY_TOKEN) return res.status(500).json({ error: "Missing SUBGRAPH_PROXY_TOKEN server environment variable" });
  const sameOriginRequest = isSameOriginRequest(req);
  if (!sameOriginRequest && !isAuthorized(req)) return res.status(403).json({ error: "Unauthorized" });
  if (!checkRateLimit(req)) return res.status(429).json({ error: "Rate limit exceeded" });

  const token = process.env.GRAPH_QUERY_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "Missing GRAPH_QUERY_TOKEN server environment variable" });
  }

  const wallet = normalizeAddressInput(req.body?.wallet || "");
  const forceRefresh = req.body?.forceRefresh === true;

  try {
    let aggregateSummary = !forceRefresh ? getCachedSummary() : null;

    if (!aggregateSummary) {
      const [totalUsersCount, swapUsersCount, rwaUsersCount, outlierPoolsCount] = await Promise.all([
        countEntityByPagination(token, "users"),
        countEntityByPagination(token, "users", "{ swapCount_gt: 0 }"),
        countEntityByPagination(token, "users", "{ rwaBuyCount_gt: 0 }"),
        countEntityByPagination(token, "pools", "{ flaggedLowLiquidityOutlier: true }"),
      ]);

      aggregateSummary = {
        totalUsersCount,
        swapUsersCount,
        rwaUsersCount,
        outlierPoolsCount,
      };
      setCachedSummary(aggregateSummary);
    }

    let targetUserRank = null;
    if (wallet) {
      const cachedRank = !forceRefresh ? getCachedRank(wallet) : undefined;
      if (cachedRank === undefined) {
        targetUserRank = await getUserRankByEffectiveVolume(token, wallet);
        setCachedRank(wallet, targetUserRank);
      } else {
        targetUserRank = cachedRank;
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
