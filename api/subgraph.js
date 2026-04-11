const STUDIO_URL = "https://api.studio.thegraph.com/query/1742338/ach/version/latest";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const SUBGRAPH_PROXY_TOKEN = (process.env.SUBGRAPH_PROXY_TOKEN || "").trim();
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 240;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5_000;

function readPositiveEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    console.warn(`[subgraph] Invalid ${name}=${raw}; using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

const RATE_LIMIT_MAX = readPositiveEnvNumber("SUBGRAPH_RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT_MAX);
const UPSTREAM_TIMEOUT_MS = readPositiveEnvNumber("UPSTREAM_TIMEOUT_MS", DEFAULT_UPSTREAM_TIMEOUT_MS);

const rateLimitByKey = new Map();
let rateLimitRequestCount = 0;
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const RATE_LIMIT_WINDOW_SECONDS = Math.max(1, Math.floor(RATE_LIMIT_WINDOW_MS / 1000));

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
  const key = `${getClientIp(req)}:${req.headers["x-app-token"] || "anon"}`;
  const now = Date.now();

  try {
    const sharedCount = await incrementSharedRateLimit(`subgraph:rl:${key}`);
    if (typeof sharedCount === "number") {
      return sharedCount <= RATE_LIMIT_MAX;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[subgraph] shared rate-limit unavailable, using in-memory fallback: ${detail}`);
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeoutId);
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
  if (!SUBGRAPH_PROXY_TOKEN) {
    return res.status(500).json({ error: "Missing SUBGRAPH_PROXY_TOKEN server environment variable" });
  }
  if (!isAuthorized(req)) return res.status(403).json({ error: "Unauthorized" });
  if (!(await checkRateLimit(req))) return res.status(429).json({ error: "Rate limit exceeded" });

  const token = process.env.GRAPH_QUERY_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "Missing GRAPH_QUERY_TOKEN server environment variable" });
  }

  try {
    const upstream = await fetchWithTimeout(STUDIO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(req.body ?? {}),
    }, UPSTREAM_TIMEOUT_MS);

    res.status(upstream.response.status);
    res.setHeader("Content-Type", "application/json");
    return res.send(upstream.text);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return res.status(504).json({ error: "Subgraph upstream timeout" });
    }
    const message = err instanceof Error ? err.message : "Unknown subgraph proxy error";
    return res.status(502).json({ error: message });
  }
}
