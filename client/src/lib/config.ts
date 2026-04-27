import { JsonRpcProvider, Network } from "ethers";
import type { JsonRpcPayload, JsonRpcResult } from "ethers";

export const ARC_TESTNET_CHAIN_ID = 5042002;
const PUBLIC_ARC_RPC = "https://rpc.testnet.arc.network";
const PRIMARY_ALCHEMY_KEY = import.meta.env.VITE_ALCHEMY_KEY;
const BACKUP_ALCHEMY_KEY = import.meta.env.VITE_ALCHEMY_BACKUP_KEY;
const FAILOVER_STORAGE_KEY = "achswap_rpc_failover_v1";
const MAX_ALCHEMY_FAILURES = 3;
const ALCHEMY_TIMEOUT_MS = 2200;
const PUBLIC_TIMEOUT_MS = 3200;

type RpcRole = "primary" | "backup" | "public";

interface RpcEndpoint {
  role: RpcRole;
  timeoutMs: number;
  url: string;
}

export interface ManagedRpcAttempt {
  timeoutMs: number;
  url: string;
}

interface RpcFailoverState {
  alchemyFailureCount: number;
  permanentPublicUntil: number | null; // Timestamp when permanent public mode expires, null if inactive
  preferredRole: RpcRole;
  updatedAt: number;
}

const DEFAULT_FAILOVER_STATE: RpcFailoverState = {
  alchemyFailureCount: 0,
  permanentPublicUntil: null,
  preferredRole: "primary",
  updatedAt: 0,
};

const networkCache = new Map<number, Network>();
const failoverStateCache = new Map<number, RpcFailoverState>();

const RPC_CONFIG = {
  arcTestnet: getArcPrimaryUrl(),
};

function getArcPrimaryUrl(): string {
  return PRIMARY_ALCHEMY_KEY
    ? `https://arc-testnet.g.alchemy.com/v2/${PRIMARY_ALCHEMY_KEY}`
    : PUBLIC_ARC_RPC;
}

function getArcBackupUrl(): string | null {
  return BACKUP_ALCHEMY_KEY
    ? `https://arc-testnet.g.alchemy.com/v2/${BACKUP_ALCHEMY_KEY}`
    : null;
}

function getNetwork(chainId: number): Network {
  let network = networkCache.get(chainId);
  if (!network) {
    network = Network.from(chainId);
    networkCache.set(chainId, network);
  }
  return network;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && !!window.sessionStorage;
}

function loadStoredFailoverMap(): Record<string, RpcFailoverState> {
  if (!canUseStorage()) return {};
  try {
    const raw = window.sessionStorage.getItem(FAILOVER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveFailoverState(chainId: number, state: RpcFailoverState) {
  failoverStateCache.set(chainId, state);
  if (!canUseStorage()) return;

  try {
    const stored = loadStoredFailoverMap();
    stored[String(chainId)] = state;
    window.sessionStorage.setItem(FAILOVER_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Ignore session storage issues.
  }
}

function getFailoverState(chainId: number): RpcFailoverState {
  const cached = failoverStateCache.get(chainId);
  if (cached) return cached;

  const stored = loadStoredFailoverMap()[String(chainId)];
  const state: RpcFailoverState =
    stored && typeof stored === "object"
       ? {
           alchemyFailureCount: Number(stored.alchemyFailureCount) || 0,
           permanentPublicUntil: Number(stored.permanentPublicUntil) || null,
           preferredRole:
             stored.preferredRole === "backup" || stored.preferredRole === "public"
               ? stored.preferredRole
               : "primary",
           updatedAt: Number(stored.updatedAt) || 0,
         }
      : { ...DEFAULT_FAILOVER_STATE };

  failoverStateCache.set(chainId, state);
  return state;
}

function uniqueEndpoints(endpoints: Array<RpcEndpoint | null | undefined>): RpcEndpoint[] {
  const seen = new Set<string>();
  const result: RpcEndpoint[] = [];

  for (const endpoint of endpoints) {
    if (!endpoint) continue;
    if (seen.has(endpoint.url)) continue;
    seen.add(endpoint.url);
    result.push(endpoint);
  }

  return result;
}

function getConfiguredRpcEndpoints(chainId: number): RpcEndpoint[] {
  switch (chainId) {
    case ARC_TESTNET_CHAIN_ID:
      return uniqueEndpoints([
        { role: "primary", timeoutMs: ALCHEMY_TIMEOUT_MS, url: getArcPrimaryUrl() },
        getArcBackupUrl()
          ? { role: "backup", timeoutMs: ALCHEMY_TIMEOUT_MS, url: getArcBackupUrl()! }
          : null,
        { role: "public", timeoutMs: PUBLIC_TIMEOUT_MS, url: PUBLIC_ARC_RPC },
      ]);
    default:
      return uniqueEndpoints([
        { role: "public", timeoutMs: PUBLIC_TIMEOUT_MS, url: getArcPrimaryUrl() },
      ]);
  }
}

function getEndpointByRole(endpoints: RpcEndpoint[], role: RpcRole): RpcEndpoint | undefined {
  return endpoints.find((endpoint) => endpoint.role === role);
}

function getNextPreferredRole(chainId: number, currentRole: RpcRole): RpcRole {
  const endpoints = getConfiguredRpcEndpoints(chainId);
  const primary = getEndpointByRole(endpoints, "primary");
  const backup = getEndpointByRole(endpoints, "backup");

  if (currentRole === "primary" && backup) return "backup";
  if (currentRole === "backup" && primary) return "primary";
  return "public";
}

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minute cooldown for permanent public mode
const DEDUPE_WINDOW_MS = 1000; // 1 second dedupe window for failure registration
const FAILURE_THRESHOLD = 2; // Consecutive failures before registering
const endpointFailureMap = new Map<string, { count: number, lastRegisteredAt: number }>();

function registerAlchemyFailure(chainId: number, role: RpcRole) {
  if (role === "public") return;

  const current = getFailoverState(chainId);
  const nextCount = current.alchemyFailureCount + 1;
  const now = Date.now();
  const nextState: RpcFailoverState =
    nextCount >= MAX_ALCHEMY_FAILURES
      ? {
          alchemyFailureCount: nextCount,
          permanentPublicUntil: now + COOLDOWN_MS,
          preferredRole: "public",
          updatedAt: now,
        }
      : {
          alchemyFailureCount: nextCount,
          permanentPublicUntil: null,
          preferredRole: getNextPreferredRole(chainId, role),
          updatedAt: now,
        };

  saveFailoverState(chainId, nextState);
}

function resetEndpointFailure(url: string) {
  const entry = endpointFailureMap.get(url);
  if (!entry) return;
  entry.count = 0;
  entry.lastRegisteredAt = 0;
}

function resetAlchemyFailureCount(chainId: number) {
  const state = getFailoverState(chainId);
  const updatedState: RpcFailoverState = {
    ...state,
    alchemyFailureCount: 0,
    updatedAt: Date.now(),
  };
  // If we were in permanent public mode due to alchemy failures, exit it
  if (state.permanentPublicUntil) {
    updatedState.permanentPublicUntil = null;
    updatedState.preferredRole = "primary";
  }
  saveFailoverState(chainId, updatedState);
}

function trackEndpointFailure(chainId: number, endpoint: RpcEndpoint) {
  const now = Date.now();
  let entry = endpointFailureMap.get(endpoint.url);
  if (!entry) {
    entry = { count: 0, lastRegisteredAt: 0 };
    endpointFailureMap.set(endpoint.url, entry);
  }

  if (now - entry.lastRegisteredAt > DEDUPE_WINDOW_MS) {
    entry.count++;
    entry.lastRegisteredAt = now;
    if (entry.count >= FAILURE_THRESHOLD) {
      registerAlchemyFailure(chainId, endpoint.role);
    }
  }
}

function getRpcAttemptOrder(chainId: number): RpcEndpoint[] {
  const endpoints = getConfiguredRpcEndpoints(chainId);
  const publicEndpoint = getEndpointByRole(endpoints, "public");
  let state = getFailoverState(chainId);

  // Check if permanent public cooldown has expired
  if (state.permanentPublicUntil && Date.now() > state.permanentPublicUntil) {
    const updatedState: RpcFailoverState = { ...state, permanentPublicUntil: null, alchemyFailureCount: 0, preferredRole: "primary" };
    saveFailoverState(chainId, updatedState);
    state = updatedState;
  }

  if (!publicEndpoint) return endpoints;
  if (state.permanentPublicUntil) return [publicEndpoint];

  const preferred =
    getEndpointByRole(endpoints, state.preferredRole) ??
    getEndpointByRole(endpoints, "primary") ??
    getEndpointByRole(endpoints, "backup") ??
    publicEndpoint;

  return uniqueEndpoints([
    preferred,
    ...endpoints.filter((endpoint) => endpoint.url !== preferred.url),
  ]);
}

function createTimeoutSignal(timeoutMs: number): { cancel: () => void; signal: AbortSignal } {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => globalThis.clearTimeout(timer),
  };
}

function normalizeRpcBatch(json: unknown): Array<JsonRpcResult> {
  if (Array.isArray(json)) return json as Array<JsonRpcResult>;
  return [json as JsonRpcResult];
}

export function isRetryableRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const code = "code" in error ? Number((error as { code?: unknown }).code) : NaN;
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "").toLowerCase() : "";

  if ([-32005, -32016, 429].includes(code)) return true;

  return [
    "alchemy",
    "credit",
    "compute units",
    "rate limit",
    "too many requests",
    "timeout",
    "timed out",
    "service unavailable",
    "temporarily unavailable",
    "upstream",
    "over capacity",
    "capacity",
    "payment required",
    "limit exceeded",
  ].some((token) => message.includes(token));
}

function shouldFailoverFromResponse(json: unknown): boolean {
  if (Array.isArray(json)) {
    const errors = json
      .map((entry) => (entry && typeof entry === "object" ? (entry as { error?: unknown }).error : undefined))
      .filter(Boolean);

    return errors.length > 0 && errors.length === json.length && errors.every(isRetryableRpcError);
  }

  if (json && typeof json === "object" && "error" in json) {
    return isRetryableRpcError((json as { error?: unknown }).error);
  }

  return false;
}

async function fetchJsonRpc(endpoint: RpcEndpoint, payload: Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
  const body = JSON.stringify(payload.length === 1 ? payload[0] : payload);
  const { signal, cancel } = createTimeoutSignal(endpoint.timeoutMs);

  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    const json = await response.json();
    if (shouldFailoverFromResponse(json)) {
      throw new Error("Retryable RPC upstream failure");
    }

    return normalizeRpcBatch(json);
  } finally {
    cancel();
  }
}

class BatchRpcProvider extends JsonRpcProvider {
  private readonly chainId: number;

  constructor(chainId: number, network: Network) {
    // Note: Constructor snapshots the first RPC endpoint for initial connection.
    // The _send() method re-evaluates getRpcAttemptOrder(this.chainId) on every request,
    // ensuring runtime failover order is always current and no external code reads stale connection URLs.
    super(getRpcAttemptOrder(chainId)[0]?.url ?? getArcPrimaryUrl(), network, {
      batchMaxCount: 20,
      batchStallTime: 10,
      staticNetwork: network,
    });
    this.chainId = chainId;
  }

  async _send(payload: Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    const attempts = getRpcAttemptOrder(this.chainId);
    let lastError: unknown = null;

    for (const endpoint of attempts) {
      try {
        const result = await fetchJsonRpc(endpoint, payload);
        resetEndpointFailure(endpoint.url);
        return result;
      } catch (error) {
        lastError = error;
        trackEndpointFailure(this.chainId, endpoint);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("RPC request failed");
  }
}

export const FALLBACK_RPC = PUBLIC_ARC_RPC;
export { RPC_CONFIG };

export function getRpcUrl(chainId: number): string {
  switch (chainId) {
    case ARC_TESTNET_CHAIN_ID:
      return getArcPrimaryUrl();
    default:
      return getArcPrimaryUrl();
  }
}

export function getRpcUrls(chainId: number): string[] {
  return getConfiguredRpcEndpoints(chainId).map((endpoint) => endpoint.url);
}

export function getManagedRpcAttempts(chainId: number): ManagedRpcAttempt[] {
  return getRpcAttemptOrder(chainId).map(({ timeoutMs, url }) => ({ timeoutMs, url }));
}

export function getRpcTimeoutMs(url: string): number {
  return url === PUBLIC_ARC_RPC ? PUBLIC_TIMEOUT_MS : ALCHEMY_TIMEOUT_MS;
}

export function getPublicRpcUrl(chainId: number): string {
  switch (chainId) {
    case ARC_TESTNET_CHAIN_ID:
      return PUBLIC_ARC_RPC;
    default:
      return getArcPrimaryUrl();
  }
}

export function reportRpcFailure(chainId: number, url: string) {
  const endpoint = getConfiguredRpcEndpoints(chainId).find((candidate) => candidate.url === url);
  if (!endpoint) return;
  trackEndpointFailure(chainId, endpoint);
}

export function reportRpcSuccess(url: string) {
  resetEndpointFailure(url);
  // Also reset alchemy failure count for the chain associated with this URL
  // We need to determine the chainId from the URL to reset the failover state
  // Since we don't have direct access to chainId here, we'll check all configured chains
  // This is acceptable as the number of chains is small
  [ARC_TESTNET_CHAIN_ID].forEach((chainId) => {
    const endpoints = getConfiguredRpcEndpoints(chainId);
    if (endpoints.some((endpoint) => endpoint.url === url)) {
      resetAlchemyFailureCount(chainId);
    }
  });
}

export function createAlchemyProvider(chainId: number): JsonRpcProvider {
  return new BatchRpcProvider(chainId, getNetwork(chainId));
}

export async function warmRpcProvider(chainId: number): Promise<void> {
  const provider = createAlchemyProvider(chainId);
  await provider.getBlockNumber();
}
