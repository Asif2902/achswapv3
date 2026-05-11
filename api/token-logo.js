const TOKEN_LOGO_FALLBACK_URL = "/img/logos/unknown-token.png";
const KNOWN_IPFS_GATEWAY_HOSTS = new Set([
  "gateway.pinata.cloud",
  "ipfs.io",
  "cloudflare-ipfs.com",
  "dweb.link",
  "w3s.link",
  "nftstorage.link",
]);
const CIDV0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CIDV1_BASE32_RE = /^b[a-z2-7]{20,}$/i;
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://nftstorage.link/ipfs/",
];
const LOGO_FETCH_TIMEOUT_MS = 2500;
const MAX_IMAGE_BYTES = 1_500_000;
const SUCCESS_CACHE_CONTROL = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000";
const FALLBACK_CACHE_CONTROL = "no-store, max-age=0";
const MEMORY_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_MEMORY_CACHE_ENTRIES = 128;

const logoCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRawCidPath(source) {
  const candidate = String(source || "").replace(/^\/+/, "").split("/")[0] || "";
  return CIDV0_RE.test(candidate) || CIDV1_BASE32_RE.test(candidate);
}

function normalizeIpfsSource(source) {
  const trimmed = String(source || "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("ipfs://")) {
    const suffix = trimmed.slice("ipfs://".length).replace(/^\/+/, "");
    return suffix ? `ipfs://${suffix}` : null;
  }

  if (isRawCidPath(trimmed)) {
    return `ipfs://${trimmed.replace(/^\/+/, "")}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (!KNOWN_IPFS_GATEWAY_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }

    const marker = "/ipfs/";
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }

    const suffix = decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length)).replace(/^\/+/, "");
    return suffix ? `ipfs://${suffix}` : null;
  } catch {
    return null;
  }
}

function getGatewayCandidates(normalizedIpfsSource) {
  const path = normalizedIpfsSource.slice("ipfs://".length);
  return IPFS_GATEWAYS.map((prefix) => `${prefix}${path}`);
}

function getCachedLogo(cacheKey) {
  const cached = logoCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    logoCache.delete(cacheKey);
    return null;
  }
  cached.lastAccessedAt = Date.now();
  return cached;
}

function setCachedLogo(cacheKey, payload) {
  if (logoCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    let oldestKey = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of logoCache.entries()) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      logoCache.delete(oldestKey);
    }
  }

  logoCache.set(cacheKey, {
    ...payload,
    expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
    lastAccessedAt: Date.now(),
  });
}

function inferContentType(sourcePath) {
  const lower = String(sourcePath || "").toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function writeImageHeaders(res, payload) {
  res.setHeader("Content-Type", payload.contentType);
  res.setHeader("Content-Length", String(payload.body.length));
  res.setHeader("Cache-Control", SUCCESS_CACHE_CONTROL);
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendLogo(res, payload) {
  res.statusCode = 200;
  writeImageHeaders(res, payload);
  res.end(payload.body);
}

function sendFallback(res) {
  res.statusCode = 302;
  res.setHeader("Location", TOKEN_LOGO_FALLBACK_URL);
  res.setHeader("Cache-Control", FALLBACK_CACHE_CONTROL);
  res.end();
}

async function fetchImageBuffer(url, sourcePath) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gateway returned ${response.status}`);
    }

    const reportedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(reportedLength) && reportedLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${reportedLength}`);
    }

    const headerContentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    const contentType = headerContentType.startsWith("image/")
      ? headerContentType
      : inferContentType(sourcePath);

    if (!contentType.startsWith("image/")) {
      throw new Error(`Unsupported content type: ${headerContentType || "unknown"}`);
    }
    if (contentType === "image/svg+xml") {
      throw new Error("SVG token logos are not proxied");
    }

    if (!response.body?.getReader) {
      throw new Error("Gateway response body is not stream-readable");
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_BYTES) {
          controller.abort();
          await reader.cancel();
          throw new Error(`Image too large after streamed download: ${totalBytes}`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }

    const body = Buffer.concat(chunks, totalBytes);

    return { body, contentType };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveLogoFromGateways(normalizedIpfsSource) {
  const sourcePath = normalizedIpfsSource.slice("ipfs://".length);
  const candidates = getGatewayCandidates(normalizedIpfsSource);
  let lastError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    if (index > 0) {
      await sleep(120 * index);
    }

    try {
      return await fetchImageBuffer(candidates[index], sourcePath);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No IPFS gateway returned a valid image");
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const url = new URL(req.url, "http://localhost");
  const normalizedIpfsSource = normalizeIpfsSource(url.searchParams.get("src"));
  if (!normalizedIpfsSource) {
    return sendFallback(res);
  }

  const cached = getCachedLogo(normalizedIpfsSource);
  if (cached) {
    if (req.method === "HEAD") {
      res.statusCode = 200;
      writeImageHeaders(res, cached);
      return res.end();
    }
    return sendLogo(res, cached);
  }

  try {
    const resolved = await resolveLogoFromGateways(normalizedIpfsSource);
    setCachedLogo(normalizedIpfsSource, resolved);

    if (req.method === "HEAD") {
      res.statusCode = 200;
      writeImageHeaders(res, resolved);
      return res.end();
    }

    return sendLogo(res, resolved);
  } catch (error) {
    console.warn("[token-logo] Failed to proxy logo:", error);
    return sendFallback(res);
  }
}
