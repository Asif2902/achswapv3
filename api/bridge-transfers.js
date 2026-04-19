import { ethers } from "ethers";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((v) => normalizeOrigin(v))
  .filter(Boolean);

const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const HAS_REDIS = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

const DEFAULT_RATE_LIMIT_PER_MINUTE = 240;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_TRANSFER_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TRANSFERS_PER_WALLET = 100;
const CLAIM_RECONCILE_LIMIT = 6;
const OWNERSHIP_PROOF_MAX_TTL_MS = 10 * 60_000;
const OWNERSHIP_PROOF_CLOCK_SKEW_MS = 30_000;

const RPC_PROBE_TIMEOUT_MS = 4_500;
const RPC_CACHE_REVALIDATE_MS = 30_000;
const CLAIM_RECONCILE_CACHE_TTL_MS = 45_000;

const memoryRateLimitByKey = new Map();
let memoryRateLimitRequestCount = 0;

const providerCacheByChainId = new Map();
const providerInFlightByChainId = new Map();
const claimReconcileCacheByHash = new Map();

const MEMORY_TRANSFER_PRUNE_INTERVAL = 64;
let memoryTransferOperationCount = 0;

const inMemoryTransfersByHash = new Map();
const inMemoryWalletIndex = new Map();

const TOKEN_MESSENGER_V2_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
];

const MESSAGE_TRANSMITTER_V2_ABI = [
  "function usedNonces(bytes32) view returns (uint256)",
  "function NONCE_USED() view returns (uint256)",
];

const MESSAGE_TRANSMITTER_EVENTS_ABI = [
  "event MessageReceived(address indexed caller, uint32 sourceDomain, uint64 nonce, bytes32 sender, bytes messageBody)",
  "event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 nonce, bytes32 sender, bytes messageBody)",
];

const tokenMessengerInterface = new ethers.Interface(TOKEN_MESSENGER_V2_ABI);
const messageTransmitterEventsInterface = new ethers.Interface(MESSAGE_TRANSMITTER_EVENTS_ABI);

const TESTNET_TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const TESTNET_MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

const CCTP_TESTNET_CHAINS = [
  {
    chainId: 5042002,
    domain: 26,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://rpc.testnet.arc.network",
      "https://arc-testnet.drpc.org",
      "https://rpc.quicknode.testnet.arc.network",
      "https://rpc.blockdaemon.testnet.arc.network",
    ],
  },
  {
    chainId: 11155111,
    domain: 0,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://sepolia.drpc.org",
      "https://rpc.sepolia.org",
      "https://sepolia.gateway.tenderly.co",
    ],
  },
  {
    chainId: 43113,
    domain: 1,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://api.avax-test.network/ext/bc/C/rpc",
      "https://avalanche-fuji-c-chain-rpc.publicnode.com",
      "https://avalanche-fuji.drpc.org",
    ],
  },
  {
    chainId: 11155420,
    domain: 2,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://sepolia.optimism.io",
      "https://optimism-sepolia-rpc.publicnode.com",
      "https://optimism-sepolia.drpc.org",
    ],
  },
  {
    chainId: 421614,
    domain: 3,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia-rpc.publicnode.com",
      "https://arbitrum-sepolia.drpc.org",
    ],
  },
  {
    chainId: 84532,
    domain: 6,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://sepolia.base.org",
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
    ],
  },
  {
    chainId: 80002,
    domain: 7,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://rpc-amoy.polygon.technology",
      "https://polygon-amoy.gateway.tenderly.co",
      "https://polygon-amoy.api.onfinality.io/public",
    ],
  },
  {
    chainId: 1301,
    domain: 10,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://sepolia.unichain.org",
      "https://unichain-sepolia.drpc.org",
    ],
  },
  {
    chainId: 59141,
    domain: 11,
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    rpcUrls: [
      "https://rpc.sepolia.linea.build",
      "https://linea-sepolia-rpc.publicnode.com",
      "https://linea-sepolia.drpc.org",
    ],
  },
];

const chainById = new Map(CCTP_TESTNET_CHAINS.map((chain) => [chain.chainId, chain]));
const chainByDomain = new Map(CCTP_TESTNET_CHAINS.map((chain) => [chain.domain, chain]));

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
    this.statusCode = status;
  }
}

function readPositiveEnvNumber(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

const RATE_LIMIT_PER_MINUTE = readPositiveEnvNumber(
  "BRIDGE_TRANSFER_RATE_LIMIT_PER_MINUTE",
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  1,
  10_000,
);
const TRANSFER_TTL_SECONDS = readPositiveEnvNumber(
  "BRIDGE_TRANSFER_TTL_SECONDS",
  DEFAULT_TRANSFER_TTL_SECONDS,
  60,
  60 * 60 * 24 * 30,
);

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

function sameOrigin(req) {
  const originHeader = req.headers.origin;
  if (!originHeader) return false;

  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  if (!host) return false;

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:$/, "");

  const serverOrigin = `${proto}://${host}`.toLowerCase();
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
  return ALLOWED_ORIGINS.includes(normalizeOrigin(origin));
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedBrowserOrigin(req)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function rateLimitRedisKey(clientKey) {
  return `bridge:ratelimit:${clientKey}`;
}

function pruneMemoryRateLimitBuckets(now) {
  for (const [key, state] of memoryRateLimitByKey) {
    if (!state || typeof state.resetAt !== "number" || state.resetAt <= now) {
      memoryRateLimitByKey.delete(key);
    }
  }
}

function normalizeNonceHex(value) {
  if (value == null) return null;

  try {
    if (typeof value === "bigint" || typeof value === "number") {
      const asBigInt = BigInt(value);
      if (asBigInt < 0n) return null;
      return `0x${asBigInt.toString(16).padStart(64, "0")}`;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (!normalized) return null;
      if (/^0x[0-9a-f]+$/.test(normalized)) {
        const body = normalized.slice(2);
        if (body.length > 64) return null;
        return `0x${body.padStart(64, "0")}`;
      }
      if (/^[0-9]+$/.test(normalized)) {
        const asBigInt = BigInt(normalized);
        return `0x${asBigInt.toString(16).padStart(64, "0")}`;
      }
      return null;
    }

    if (typeof value === "object" && value !== null && "toString" in value) {
      const maybe = String(value);
      return normalizeNonceHex(maybe);
    }
  } catch {
    return null;
  }

  return null;
}

function getCachedClaimReconcileResult(burnTxHash) {
  const now = Date.now();
  const cached = claimReconcileCacheByHash.get(burnTxHash);
  if (!cached) return null;
  if (!Number.isFinite(cached.expiresAt) || cached.expiresAt <= now) {
    claimReconcileCacheByHash.delete(burnTxHash);
    return null;
  }
  return Boolean(cached.claimed);
}

function setCachedClaimReconcileResult(burnTxHash, claimed) {
  claimReconcileCacheByHash.set(burnTxHash, {
    claimed: Boolean(claimed),
    expiresAt: Date.now() + CLAIM_RECONCILE_CACHE_TTL_MS,
  });

  if (claimReconcileCacheByHash.size > 1024) {
    const now = Date.now();
    for (const [hash, entry] of claimReconcileCacheByHash) {
      if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
        claimReconcileCacheByHash.delete(hash);
      }
    }
  }
}

function checkRateLimitInMemory(clientKey) {
  const now = Date.now();

  memoryRateLimitRequestCount += 1;
  if (memoryRateLimitRequestCount % 64 === 0) pruneMemoryRateLimitBuckets(now);

  const state = memoryRateLimitByKey.get(clientKey) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  state.count += 1;
  memoryRateLimitByKey.set(clientKey, state);
  return state.count <= RATE_LIMIT_PER_MINUTE;
}

async function checkRateLimit(req) {
  const clientKey = getClientIp(req);

  if (!HAS_REDIS) {
    return checkRateLimitInMemory(clientKey);
  }

  try {
    const ttlSeconds = Math.max(1, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
    const [countRaw] = await upstashPipeline([
      ["INCR", rateLimitRedisKey(clientKey)],
      ["EXPIRE", rateLimitRedisKey(clientKey), String(ttlSeconds), "NX"],
    ]);

    const count = Number(countRaw);
    if (!Number.isFinite(count)) {
      return false;
    }

    return count <= RATE_LIMIT_PER_MINUTE;
  } catch (err) {
    console.warn("[bridge-transfers] Redis rate limit failed; falling back to memory", err);
    return checkRateLimitInMemory(clientKey);
  }
}

function canonicalHash(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function isHash(value) {
  return /^0x[a-f0-9]{64}$/.test(canonicalHash(value));
}

function isWallet(value) {
  try {
    return ethers.isAddress(String(value || ""));
  } catch {
    return false;
  }
}

function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function isTruthyFlag(value) {
  if (Array.isArray(value)) {
    return value.some((entry) => isTruthyFlag(entry));
  }

  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function trimErrorMessage(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
}

function normalizeAttestation(input) {
  if (!input || typeof input !== "object") return undefined;
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const attestation = typeof input.attestation === "string" ? input.attestation.trim() : "";
  if (!message || !attestation) return undefined;
  return { message, attestation };
}

function normalizeTransferRecord(input) {
  if (!input || typeof input !== "object") return null;

  const burnTxHash = canonicalHash(input.burnTxHash || input.id);
  const userAddress = canonicalAddress(input.userAddress);
  const sourceDomain = toInt(input.sourceDomain);
  const sourceChainId = toInt(input.sourceChainId);
  const destDomain = toInt(input.destDomain);
  const destChainId = toInt(input.destChainId);
  const amount = typeof input.amount === "string" ? input.amount : String(input.amount || "");
  const timestampRaw = Number(input.timestamp);
  const timestamp = Number.isFinite(timestampRaw) && timestampRaw > 0 ? Math.trunc(timestampRaw) : Date.now();

  if (!isHash(burnTxHash)) return null;
  if (!isWallet(userAddress)) return null;
  if (!Number.isInteger(sourceDomain) || !Number.isInteger(sourceChainId)) return null;
  if (!Number.isInteger(destDomain) || !Number.isInteger(destChainId)) return null;
  if (!amount || Number.isNaN(Number(amount))) return null;

  const requestedStatus = String(input.status || "attesting").toLowerCase();
  let status = "attesting";
  if (requestedStatus === "ready_to_mint") status = "ready_to_mint";
  if (requestedStatus === "minting") status = "minting";
  if (requestedStatus === "failed") status = "failed";

  return {
    id: burnTxHash,
    burnTxHash,
    sourceDomain,
    sourceChainId,
    destDomain,
    destChainId,
    amount,
    userAddress,
    timestamp,
    attestation: normalizeAttestation(input.attestation),
    status,
    mintTxHash: isHash(input.mintTxHash) ? canonicalHash(input.mintTxHash) : undefined,
    error: trimErrorMessage(input.error),
    expiresAt: Number.isFinite(Number(input.expiresAt)) ? Math.trunc(Number(input.expiresAt)) : undefined,
    updatedAt: Date.now(),
  };
}

const TRANSFER_STATUS_ORDER = {
  attesting: 1,
  ready_to_mint: 2,
  minting: 3,
  complete: 4,
};

function normalizeTransferStatus(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "failed") return "failed";
  if (normalized in TRANSFER_STATUS_ORDER) return normalized;
  return "attesting";
}

function selectProgressStatus(existingStatus, incomingStatus, incomingHasAttestation) {
  const existing = normalizeTransferStatus(existingStatus);
  let incoming = normalizeTransferStatus(incomingStatus);

  if (existing === "failed") return "failed";
  if (incoming === "failed") incoming = "attesting";

  if (incomingHasAttestation && incoming === "attesting") {
    incoming = "ready_to_mint";
  }

  const existingRank = TRANSFER_STATUS_ORDER[existing] || 0;
  const incomingRank = TRANSFER_STATUS_ORDER[incoming] || 0;
  return incomingRank >= existingRank ? incoming : existing;
}

function pruneMemoryTransferState() {
  const now = Date.now();
  const expiredHashes = [];

  for (const [hash, record] of inMemoryTransfersByHash) {
    if (!record || typeof record !== "object") {
      expiredHashes.push(hash);
      continue;
    }

    const expiresAt = Number(record.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
      expiredHashes.push(hash);
    }
  }

  for (const hash of expiredHashes) {
    const existing = inMemoryTransfersByHash.get(hash);
    inMemoryTransfersByHash.delete(hash);

    const wallet = existing?.userAddress;
    if (!wallet) continue;

    const index = inMemoryWalletIndex.get(wallet);
    if (!index) continue;
    index.delete(hash);
    if (index.size === 0) {
      inMemoryWalletIndex.delete(wallet);
    }
  }

  for (const [wallet, index] of inMemoryWalletIndex) {
    if (!index || index.size === 0) {
      inMemoryWalletIndex.delete(wallet);
      continue;
    }

    for (const hash of index.keys()) {
      if (!inMemoryTransfersByHash.has(hash)) {
        index.delete(hash);
      }
    }

    if (index.size === 0) {
      inMemoryWalletIndex.delete(wallet);
    }
  }
}

function touchMemoryTransferPrune() {
  memoryTransferOperationCount += 1;
  if (memoryTransferOperationCount % MEMORY_TRANSFER_PRUNE_INTERVAL === 0) {
    pruneMemoryTransferState();
  }
}

function trimMemoryWalletIndex(wallet) {
  const existing = inMemoryWalletIndex.get(wallet);
  if (!existing) return;
  if (existing.size <= MAX_TRANSFERS_PER_WALLET) return;

  const ordered = [...existing.entries()]
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  for (let i = MAX_TRANSFERS_PER_WALLET; i < ordered.length; i += 1) {
    const [hash] = ordered[i];
    existing.delete(hash);
    inMemoryTransfersByHash.delete(hash);
  }

  if (existing.size === 0) {
    inMemoryWalletIndex.delete(wallet);
  }
}

function mergeTransferField(existingValue, incomingValue) {
  return incomingValue !== undefined && incomingValue !== null ? incomingValue : existingValue;
}

function txKey(burnTxHash) {
  return `bridge:tx:${burnTxHash}`;
}

function walletKey(wallet) {
  return `bridge:wallet:${wallet}`;
}

async function upstashPipeline(commands) {
  const pipelineUrl = `${UPSTASH_REDIS_REST_URL.replace(/\/$/, "")}/pipeline`;
  const response = await fetch(pipelineUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    const bodySnippet = rawBody.length > 500 ? `${rawBody.slice(0, 500)}...` : rawBody;
    throw new Error(`Redis pipeline failed: ${response.status} ${bodySnippet}`);
  }

  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    const bodySnippet = rawBody.length > 500 ? `${rawBody.slice(0, 500)}...` : rawBody;
    throw new Error(`Redis pipeline returned non-JSON payload: ${bodySnippet}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error("Redis pipeline returned invalid response");
  }

  return payload.map((item) => {
    if (item && item.error) throw new Error(`Redis command failed: ${item.error}`);
    return item ? item.result : null;
  });
}

function setMemoryTransfer(record) {
  const now = Date.now();
  const expiresAt = Number(record?.expiresAt);
  const resolvedExpiresAt = Number.isFinite(expiresAt) && expiresAt > now
    ? Math.trunc(expiresAt)
    : now + TRANSFER_TTL_SECONDS * 1000;

  const normalizedRecord = {
    ...record,
    expiresAt: resolvedExpiresAt,
  };

  inMemoryTransfersByHash.set(normalizedRecord.burnTxHash, normalizedRecord);
  const wallet = normalizedRecord.userAddress;
  const score = Number(normalizedRecord.timestamp) || now;
  const existing = inMemoryWalletIndex.get(wallet) || new Map();
  existing.set(normalizedRecord.burnTxHash, score);
  inMemoryWalletIndex.set(wallet, existing);

  trimMemoryWalletIndex(wallet);
  touchMemoryTransferPrune();
}

function deleteMemoryTransfer(burnTxHash, wallet) {
  inMemoryTransfersByHash.delete(burnTxHash);
  if (!wallet) return;
  const existing = inMemoryWalletIndex.get(wallet);
  if (!existing) return;
  existing.delete(burnTxHash);
  if (existing.size === 0) inMemoryWalletIndex.delete(wallet);

  touchMemoryTransferPrune();
}

async function saveTransferRecord(record) {
  if (HAS_REDIS) {
    await upstashPipeline([
      ["SET", txKey(record.burnTxHash), JSON.stringify(record), "EX", String(TRANSFER_TTL_SECONDS)],
      ["ZADD", walletKey(record.userAddress), String(record.timestamp || Date.now()), record.burnTxHash],
      ["EXPIRE", walletKey(record.userAddress), String(TRANSFER_TTL_SECONDS)],
    ]);
    return;
  }

  setMemoryTransfer(record);
}

async function getTransferRecord(burnTxHash) {
  if (HAS_REDIS) {
    const [raw] = await upstashPipeline([["GET", txKey(burnTxHash)]]);
    if (!raw || typeof raw !== "string") return null;
    try {
      return normalizeTransferRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  touchMemoryTransferPrune();

  const record = inMemoryTransfersByHash.get(burnTxHash);
  return record ? normalizeTransferRecord(record) : null;
}

async function deleteTransferRecord(burnTxHash, wallet) {
  if (HAS_REDIS) {
    if (wallet) {
      await upstashPipeline([
        ["DEL", txKey(burnTxHash)],
        ["ZREM", walletKey(wallet), burnTxHash],
      ]);
    } else {
      await upstashPipeline([["DEL", txKey(burnTxHash)]]);
    }
    return;
  }

  deleteMemoryTransfer(burnTxHash, wallet);
}

async function listWalletHashes(wallet) {
  if (HAS_REDIS) {
    const [hashes] = await upstashPipeline([
      ["ZREVRANGE", walletKey(wallet), "0", String(MAX_TRANSFERS_PER_WALLET - 1)],
    ]);
    if (!Array.isArray(hashes)) return [];
    return hashes.map(canonicalHash).filter((hash) => isHash(hash));
  }

  touchMemoryTransferPrune();

  const existing = inMemoryWalletIndex.get(wallet);
  if (!existing) return [];
  return [...existing.entries()]
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_TRANSFERS_PER_WALLET)
    .map(([hash]) => hash);
}

async function getManyTransferRecords(hashes) {
  if (!hashes.length) return [];

  if (HAS_REDIS) {
    const commands = hashes.map((hash) => ["GET", txKey(hash)]);
    const results = await upstashPipeline(commands);
    return results.map((raw, idx) => {
      if (!raw || typeof raw !== "string") return { hash: hashes[idx], transfer: null };
      try {
        const normalized = normalizeTransferRecord(JSON.parse(raw));
        return { hash: hashes[idx], transfer: normalized || null };
      } catch {
        return { hash: hashes[idx], transfer: null };
      }
    });
  }

  touchMemoryTransferPrune();

  return hashes.map((hash) => {
    const record = inMemoryTransfersByHash.get(hash);
    const transfer = normalizeTransferRecord(record);
    return { hash, transfer: transfer || null };
  });
}

async function removeWalletIndexEntries(wallet, hashes) {
  if (!hashes.length) return;

  if (HAS_REDIS) {
    await upstashPipeline([
      ["ZREM", walletKey(wallet), ...hashes],
    ]);
    return;
  }

  const existing = inMemoryWalletIndex.get(wallet);
  if (!existing) return;
  for (const hash of hashes) existing.delete(hash);
  if (existing.size === 0) inMemoryWalletIndex.delete(wallet);
}

function withTimeout(promise, timeoutMs, errorMessage) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function uniqueRpcUrls(urls) {
  return Array.from(new Set((Array.isArray(urls) ? urls : []).filter((v) => typeof v === "string" && v.length > 0)));
}

async function probeRpcUrl(rpcUrl, timeoutMs) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  try {
    await withTimeout(provider.getBlockNumber(), timeoutMs, `RPC probe timed out: ${rpcUrl}`);
    return { provider, rpcUrl, validatedAt: Date.now() };
  } catch (err) {
    try {
      provider.destroy();
    } catch {
      // ignore destroy errors
    }
    throw err;
  }
}

async function getWorkingProvider(chain) {
  const cached = providerCacheByChainId.get(chain.chainId);
  if (cached && Date.now() - cached.validatedAt < RPC_CACHE_REVALIDATE_MS) {
    return cached.provider;
  }

  const inFlight = providerInFlightByChainId.get(chain.chainId);
  if (inFlight) return inFlight;

  const resolvePromise = (async () => {
    const rpcUrls = uniqueRpcUrls(chain.rpcUrls);
    if (!rpcUrls.length) throw new Error(`No RPC URLs configured for chain ${chain.chainId}`);

    const probeResults = await Promise.allSettled(
      rpcUrls.map((url) => probeRpcUrl(url, RPC_PROBE_TIMEOUT_MS)),
    );

    const fulfilled = probeResults.filter((r) => r.status === "fulfilled");
    const winner = fulfilled.find((r) => r.value)?.value;
    if (!winner) {
      const err = new Error("All RPC probes failed");
      err.name = "RPCUnavailableError";
      throw err;
    }

    for (const result of fulfilled) {
      if (result.value.rpcUrl !== winner.rpcUrl) {
        try {
          result.value.provider.destroy();
        } catch {
          // ignore destroy errors
        }
      }
    }

    const previous = providerCacheByChainId.get(chain.chainId);
    providerCacheByChainId.set(chain.chainId, winner);
    if (previous && previous.provider !== winner.provider) {
      try {
        previous.provider.destroy();
      } catch {
        // ignore destroy errors
      }
    }
    return winner.provider;
  })();

  providerInFlightByChainId.set(chain.chainId, resolvePromise);
  try {
    return await resolvePromise;
  } finally {
    providerInFlightByChainId.delete(chain.chainId);
  }
}

async function verifyBurnTransaction(transfer) {
  const chain = chainById.get(Number(transfer.sourceChainId));
  if (!chain) throw new ValidationError("Unsupported source chain");
  if (Number(chain.domain) !== Number(transfer.sourceDomain)) {
    throw new ValidationError("Source domain does not match source chain");
  }

  const destinationChain = chainById.get(Number(transfer.destChainId));
  if (!destinationChain) throw new ValidationError("Unsupported destination chain");
  if (Number(destinationChain.domain) !== Number(transfer.destDomain)) {
    throw new ValidationError("Destination domain does not match destination chain");
  }

  const provider = await getWorkingProvider(chain);
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(transfer.burnTxHash),
    provider.getTransactionReceipt(transfer.burnTxHash),
  ]);

  if (!tx || !receipt || receipt.status !== 1) {
    throw new ValidationError("Burn transaction not confirmed on-chain");
  }

  const txTo = canonicalAddress(tx.to || "");
  const expectedTokenMessenger = canonicalAddress(chain.tokenMessengerV2);
  if (!txTo || txTo !== expectedTokenMessenger) {
    throw new ValidationError("Burn transaction was not sent to TokenMessengerV2");
  }

  const txFrom = canonicalAddress(tx.from || "");
  if (!txFrom || txFrom !== canonicalAddress(transfer.userAddress)) {
    throw new ValidationError("Burn transaction sender mismatch");
  }

  let parsed;
  try {
    parsed = tokenMessengerInterface.parseTransaction({ data: tx.data, value: tx.value ?? 0n });
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.name !== "depositForBurn") {
    throw new ValidationError("Burn transaction is not depositForBurn");
  }

  const decodedDestinationDomain = Number(parsed.args[1]);
  if (!Number.isFinite(decodedDestinationDomain) || decodedDestinationDomain !== Number(transfer.destDomain)) {
    throw new ValidationError("Burn transaction destination domain mismatch");
  }

  return true;
}

function extractCctpMessageNonce(message) {
  const normalized = String(message || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(normalized)) return null;
  const start = 2 + 12 * 2;
  const end = start + 32 * 2;
  if (normalized.length < end) return null;
  return `0x${normalized.slice(start, end)}`;
}

async function isTransferClaimed(transfer, messageOverride) {
  const chain = chainById.get(Number(transfer.destChainId));
  if (!chain) return false;

  const message = (typeof messageOverride === "string" && messageOverride) || transfer?.attestation?.message;
  if (!message) return false;
  const nonce = extractCctpMessageNonce(message);
  if (!nonce) return false;

  const provider = await getWorkingProvider(chain);
  const contract = new ethers.Contract(chain.messageTransmitterV2, MESSAGE_TRANSMITTER_V2_ABI, provider);
  const [nonceState, nonceUsed] = await Promise.all([
    contract.usedNonces(nonce),
    contract.NONCE_USED(),
  ]);

  if (BigInt(nonceUsed) > 0n) {
    return BigInt(nonceState) === BigInt(nonceUsed);
  }
  return BigInt(nonceState) > 0n;
}

async function verifyMintTransaction(transfer, mintTxHash) {
  if (!isHash(mintTxHash)) return false;
  const chain = chainById.get(Number(transfer.destChainId));
  if (!chain) return false;

  const expectedNonce = normalizeNonceHex(extractCctpMessageNonce(transfer?.attestation?.message));
  if (!expectedNonce) return false;

  const provider = await getWorkingProvider(chain);
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(mintTxHash),
    provider.getTransactionReceipt(mintTxHash),
  ]);

  if (!tx || !receipt || receipt.status !== 1) return false;
  const txTo = canonicalAddress(tx.to || "");
  const txFrom = canonicalAddress(tx.from || "");

  if (
    txTo !== canonicalAddress(chain.messageTransmitterV2)
    || txFrom !== canonicalAddress(transfer.userAddress)
  ) {
    return false;
  }

  const targetAddress = canonicalAddress(chain.messageTransmitterV2);
  for (const log of receipt.logs || []) {
    if (!log || canonicalAddress(log.address || "") !== targetAddress) continue;

    let parsed;
    try {
      parsed = messageTransmitterEventsInterface.parseLog({
        topics: log.topics,
        data: log.data,
      });
    } catch {
      continue;
    }

    if (!parsed || parsed.name !== "MessageReceived") continue;
    const eventNonce = normalizeNonceHex(parsed.args?.nonce);
    if (!eventNonce) continue;
    if (eventNonce === expectedNonce) return true;
  }

  return false;
}

function sanitizeForResponse(transfer) {
  return {
    id: transfer.id,
    burnTxHash: transfer.burnTxHash,
    sourceDomain: transfer.sourceDomain,
    sourceChainId: transfer.sourceChainId,
    destDomain: transfer.destDomain,
    destChainId: transfer.destChainId,
    amount: transfer.amount,
    userAddress: transfer.userAddress,
    timestamp: transfer.timestamp,
    attestation: transfer.attestation,
    status: transfer.status,
    mintTxHash: transfer.mintTxHash,
    error: transfer.error,
  };
}

function getOwnershipProof(req) {
  const rawProof = req.body?.ownershipProof;
  if (!rawProof || typeof rawProof !== "object") return null;

  const signedMessage = typeof rawProof.signedMessage === "string" ? rawProof.signedMessage : "";
  const signature = typeof rawProof.signature === "string" ? rawProof.signature : "";
  const issuedAtRaw = Number(rawProof.issuedAt);

  if (!signedMessage || !signature || !Number.isFinite(issuedAtRaw)) return null;
  const issuedAt = Math.trunc(issuedAtRaw);
  if (issuedAt <= 0) return null;

  return { signedMessage, signature, issuedAt };
}

async function requireSignedOwnership(req, transfer) {
  const proof = getOwnershipProof(req);
  if (!proof) {
    throw new Error("Missing ownership proof");
  }

  const now = Date.now();
  if (proof.issuedAt > now + OWNERSHIP_PROOF_CLOCK_SKEW_MS) {
    throw new Error("Ownership proof timestamp is in the future");
  }

  if (now - proof.issuedAt > OWNERSHIP_PROOF_MAX_TTL_MS) {
    throw new Error("Ownership proof expired");
  }

  let parsed;
  try {
    parsed = JSON.parse(proof.signedMessage);
  } catch {
    throw new Error("Invalid ownership proof message");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid ownership proof payload");
  }

  if (String(parsed.intent || "") !== "bridge_transfer_mutation") {
    throw new Error("Invalid ownership proof intent");
  }

  const expectedBurnTxHash = canonicalHash(transfer.burnTxHash);
  const signedBurnTxHash = canonicalHash(parsed.burnTxHash);
  if (!isHash(signedBurnTxHash) || signedBurnTxHash !== expectedBurnTxHash) {
    throw new Error("Ownership proof burn hash mismatch");
  }

  const signedIssuedAt = Number(parsed.issuedAt);
  if (!Number.isFinite(signedIssuedAt) || Math.trunc(signedIssuedAt) !== proof.issuedAt) {
    throw new Error("Ownership proof timestamp mismatch");
  }

  let recovered;
  try {
    recovered = canonicalAddress(ethers.verifyMessage(proof.signedMessage, proof.signature));
  } catch {
    throw new Error("Invalid ownership signature");
  }

  const expectedWallet = canonicalAddress(transfer.userAddress);
  if (!expectedWallet || recovered !== expectedWallet) {
    throw new Error("Ownership signature does not match transfer owner");
  }

  return true;
}

async function handleGet(req, res) {
  if (isTruthyFlag(req.query?.probe)) {
    return res.status(200).json({ ok: true, storage: HAS_REDIS ? "redis" : "memory" });
  }

  const wallet = canonicalAddress(req.query?.wallet || "");
  if (!isWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  const hashes = await listWalletHashes(wallet);
  if (!hashes.length) {
    return res.status(200).json({ transfers: [], storage: HAS_REDIS ? "redis" : "memory" });
  }

  const entries = await getManyTransferRecords(hashes);
  const staleHashSet = new Set();
  const transfers = [];

  for (const entry of entries) {
    if (!entry || !entry.hash || !entry.transfer) {
      if (entry?.hash) staleHashSet.add(entry.hash);
      continue;
    }
    const transfer = normalizeTransferRecord(entry.transfer);
    if (!transfer) {
      staleHashSet.add(entry ? entry.hash : "");
      continue;
    }
    if (canonicalAddress(transfer.userAddress) !== wallet) {
      staleHashSet.add(entry.hash);
      continue;
    }
    transfers.push(transfer);
  }

  const reconcileCandidates = transfers
    .filter((t) => (t.status === "minting" || t.status === "ready_to_mint") && t.attestation?.message)
    .sort((a, b) => {
      const aTime = Number(a.timestamp || 0);
      const bTime = Number(b.timestamp || 0);
      return aTime - bTime;
    })
    .slice(0, CLAIM_RECONCILE_LIMIT);

  const reconcileChecks = reconcileCandidates.map(async (transfer) => {
    const cachedClaimed = getCachedClaimReconcileResult(transfer.burnTxHash);
    if (cachedClaimed != null) {
      return { transfer, claimed: cachedClaimed };
    }

    const claimed = await isTransferClaimed(transfer, transfer.attestation?.message);
    setCachedClaimReconcileResult(transfer.burnTxHash, claimed);
    return { transfer, claimed };
  });

  const reconcileResults = await Promise.allSettled(reconcileChecks);
  const claimedTransfers = [];

  for (const result of reconcileResults) {
    if (result.status !== "fulfilled") continue;
    if (!result.value.claimed) continue;
    claimedTransfers.push(result.value.transfer);
  }

  if (claimedTransfers.length) {
    await Promise.allSettled(
      claimedTransfers.map(async (transfer) => {
        await deleteTransferRecord(transfer.burnTxHash, transfer.userAddress);
        staleHashSet.add(transfer.burnTxHash);
      }),
    );
  }

  const staleHashes = [...staleHashSet].filter(Boolean);
  if (staleHashes.length) {
    await removeWalletIndexEntries(wallet, staleHashes);
  }

  const active = transfers
    .filter((t) => !staleHashSet.has(t.burnTxHash))
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
    .slice(0, MAX_TRANSFERS_PER_WALLET)
    .map(sanitizeForResponse);

  return res.status(200).json({ transfers: active, storage: HAS_REDIS ? "redis" : "memory" });
}

async function handleUpsertBurn(req, res) {
  const record = normalizeTransferRecord(req.body?.transfer);
  if (!record) return res.status(400).json({ error: "Invalid transfer payload" });

  const sourceChain = chainById.get(record.sourceChainId);
  const destinationChain = chainById.get(record.destChainId);

  if (!sourceChain) return res.status(400).json({ error: "Unsupported source chain" });
  if (!destinationChain) return res.status(400).json({ error: "Unsupported destination chain" });
  if (Number(sourceChain.domain) !== Number(record.sourceDomain)) {
    return res.status(400).json({ error: "Source domain mismatch" });
  }
  if (Number(destinationChain.domain) !== Number(record.destDomain)) {
    return res.status(400).json({ error: "Destination domain mismatch" });
  }

  await verifyBurnTransaction(record);

  const existing = await getTransferRecord(record.burnTxHash);
  const recordHasAttestation = Boolean(record.attestation?.message && record.attestation?.attestation);
  const mergedStatus = selectProgressStatus(existing?.status, record.status, recordHasAttestation);

  const merged = {
    id: record.burnTxHash,
    burnTxHash: record.burnTxHash,
    sourceDomain: record.sourceDomain,
    sourceChainId: record.sourceChainId,
    destDomain: record.destDomain,
    destChainId: record.destChainId,
    amount: record.amount,
    userAddress: record.userAddress,
    timestamp: existing?.timestamp || record.timestamp,
    attestation: mergeTransferField(existing?.attestation, record.attestation),
    mintTxHash: mergeTransferField(existing?.mintTxHash, record.mintTxHash),
    error: mergeTransferField(existing?.error, record.error),
    status: mergedStatus,
    expiresAt: Date.now() + TRANSFER_TTL_SECONDS * 1000,
    updatedAt: Date.now(),
  };

  await saveTransferRecord(merged);
  return res.status(200).json({ ok: true, storage: HAS_REDIS ? "redis" : "memory" });
}

async function handleUpdateAttestation(req, res) {
  const burnTxHash = canonicalHash(req.body?.burnTxHash);
  const attestation = normalizeAttestation(req.body?.attestation);
  if (!isHash(burnTxHash) || !attestation) {
    return res.status(400).json({ error: "Invalid attestation payload" });
  }

  const transfer = await getTransferRecord(burnTxHash);
  if (!transfer) return res.status(404).json({ error: "Transfer not found" });

  try {
    await requireSignedOwnership(req, transfer);
  } catch (err) {
    return res.status(403).json({ error: err instanceof Error ? err.message : "Ownership validation failed" });
  }

  const destDomainInput = toInt(req.body?.destDomain);
  const destChainIdInput = toInt(req.body?.destChainId);

  if (
    Number.isInteger(destDomainInput)
    && destDomainInput !== Number(transfer.destDomain)
  ) {
    return res.status(400).json({ error: "Destination domain does not match burn transaction" });
  }

  if (
    Number.isInteger(destChainIdInput)
    && destChainIdInput !== Number(transfer.destChainId)
  ) {
    return res.status(400).json({ error: "Destination chain does not match burn transaction" });
  }

  let nextDestination = chainById.get(Number(transfer.destChainId)) || chainByDomain.get(Number(transfer.destDomain)) || null;

  if (Number.isInteger(destChainIdInput)) {
    const byId = chainById.get(destChainIdInput);
    if (!byId) return res.status(400).json({ error: "Unsupported destination chain" });
    if (Number.isInteger(destDomainInput) && byId.domain !== destDomainInput) {
      return res.status(400).json({ error: "Destination domain/chain mismatch" });
    }
    nextDestination = byId;
  } else if (Number.isInteger(destDomainInput)) {
    const byDomain = chainByDomain.get(destDomainInput);
    if (!byDomain) return res.status(400).json({ error: "Unsupported destination domain" });
    nextDestination = byDomain;
  }

  if (!nextDestination) {
    return res.status(400).json({ error: "Destination chain unavailable" });
  }

  const updated = {
    ...transfer,
    attestation,
    status: "ready_to_mint",
    destDomain: nextDestination.domain,
    destChainId: nextDestination.chainId,
    error: trimErrorMessage(req.body?.error),
    updatedAt: Date.now(),
  };

  await saveTransferRecord(updated);
  return res.status(200).json({ ok: true });
}

async function handleMarkMinting(req, res) {
  const burnTxHash = canonicalHash(req.body?.burnTxHash);
  if (!isHash(burnTxHash)) return res.status(400).json({ error: "Invalid burnTxHash" });

  const transfer = await getTransferRecord(burnTxHash);
  if (!transfer) return res.status(404).json({ error: "Transfer not found" });

  try {
    await requireSignedOwnership(req, transfer);
  } catch (err) {
    return res.status(403).json({ error: err instanceof Error ? err.message : "Ownership validation failed" });
  }

  const updated = {
    ...transfer,
    status: "minting",
    error: trimErrorMessage(req.body?.error),
    updatedAt: Date.now(),
  };

  await saveTransferRecord(updated);
  return res.status(200).json({ ok: true });
}

async function handleMarkAttesting(req, res) {
  const burnTxHash = canonicalHash(req.body?.burnTxHash);
  if (!isHash(burnTxHash)) return res.status(400).json({ error: "Invalid burnTxHash" });

  const transfer = await getTransferRecord(burnTxHash);
  if (!transfer) return res.status(404).json({ error: "Transfer not found" });

  try {
    await requireSignedOwnership(req, transfer);
  } catch (err) {
    return res.status(403).json({ error: err instanceof Error ? err.message : "Ownership validation failed" });
  }

  const updated = {
    ...transfer,
    status: "attesting",
    error: trimErrorMessage(req.body?.error),
    updatedAt: Date.now(),
  };

  await saveTransferRecord(updated);
  return res.status(200).json({ ok: true });
}

async function handleMarkFailed(req, res) {
  const burnTxHash = canonicalHash(req.body?.burnTxHash);
  if (!isHash(burnTxHash)) return res.status(400).json({ error: "Invalid burnTxHash" });
  const mintTxHashInput = canonicalHash(req.body?.mintTxHash || "");
  const mintTxHash = isHash(mintTxHashInput) ? mintTxHashInput : undefined;

  const transfer = await getTransferRecord(burnTxHash);
  if (!transfer) return res.status(404).json({ error: "Transfer not found" });

  try {
    await requireSignedOwnership(req, transfer);
  } catch (err) {
    return res.status(403).json({ error: err instanceof Error ? err.message : "Ownership validation failed" });
  }

  const updated = {
    ...transfer,
    status: "failed",
    mintTxHash: mergeTransferField(transfer.mintTxHash, mintTxHash),
    error: trimErrorMessage(req.body?.error),
    updatedAt: Date.now(),
  };

  await saveTransferRecord(updated);
  return res.status(200).json({ ok: true });
}

async function handleMarkComplete(req, res) {
  const burnTxHash = canonicalHash(req.body?.burnTxHash);
  const mintTxHash = canonicalHash(req.body?.mintTxHash || "");
  const message = typeof req.body?.message === "string" ? req.body.message : "";

  if (!isHash(burnTxHash)) return res.status(400).json({ error: "Invalid burnTxHash" });

  const transfer = await getTransferRecord(burnTxHash);
  if (!transfer) return res.status(200).json({ ok: true });

  try {
    await requireSignedOwnership(req, transfer);
  } catch (err) {
    return res.status(403).json({ error: err instanceof Error ? err.message : "Ownership validation failed" });
  }

  let verified = false;
  try {
    verified = await isTransferClaimed(transfer, message || transfer?.attestation?.message || "");
  } catch {
    verified = false;
  }

  if (!verified && isHash(mintTxHash)) {
    try {
      verified = await verifyMintTransaction(transfer, mintTxHash);
    } catch {
      verified = false;
    }
  }

  if (!verified) {
    return res.status(409).json({ error: "Unable to verify mint completion on-chain" });
  }

  await deleteTransferRecord(burnTxHash, transfer.userAddress);
  return res.status(200).json({ ok: true, deleted: true });
}

async function handleDismiss(req, res) {
  const burnTxHash = canonicalHash(req.body?.burnTxHash);
  if (!isHash(burnTxHash)) return res.status(400).json({ error: "Invalid burnTxHash" });

  const transfer = await getTransferRecord(burnTxHash);
  if (!transfer) return res.status(200).json({ ok: true });

  try {
    await requireSignedOwnership(req, transfer);
  } catch (err) {
    return res.status(403).json({ error: err instanceof Error ? err.message : "Ownership validation failed" });
  }

  if (transfer.status !== "failed" && transfer.status !== "complete") {
    return res.status(409).json({ error: "Only failed or completed transfers can be dismissed" });
  }

  await deleteTransferRecord(burnTxHash, transfer.userAddress);
  return res.status(200).json({ ok: true, deleted: true });
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "HEAD") {
    return res.status(200).end();
  }

  if (req.method === "OPTIONS") {
    if (req.headers.origin && !isAllowedBrowserOrigin(req)) return res.status(403).json({ error: "Origin not allowed" });
    return res.status(200).end();
  }

  if (req.headers.origin && !isAllowedBrowserOrigin(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (!await checkRateLimit(req)) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  try {
    if (req.method === "GET") {
      return await handleGet(req, res);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const action = String(req.body?.action || "").toLowerCase();
    if (action === "upsert_burn") return await handleUpsertBurn(req, res);
    if (action === "update_attestation") return await handleUpdateAttestation(req, res);
    if (action === "mark_minting") return await handleMarkMinting(req, res);
    if (action === "mark_attesting") return await handleMarkAttesting(req, res);
    if (action === "mark_failed") return await handleMarkFailed(req, res);
    if (action === "mark_complete") return await handleMarkComplete(req, res);
    if (action === "dismiss") return await handleDismiss(req, res);

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    if (
      (err instanceof Error && (err.name === "AggregateError" || err.name === "RPCUnavailableError"))
      || (err instanceof Error && err.message === "All RPC probes failed")
    ) {
      return res.status(502).json({ error: "All RPC endpoints failed" });
    }
    if (
      err instanceof ValidationError
      || (err && typeof err === "object" && (Number.isInteger(err.status) || Number.isInteger(err.statusCode)))
    ) {
      const status = Number(err?.status || err?.statusCode || 400);
      const message = err instanceof Error ? err.message : "Validation failed";
      return res.status(status).json({ error: message });
    }
    return res.status(500).json({ error: "Unexpected bridge transfer error" });
  }
}
