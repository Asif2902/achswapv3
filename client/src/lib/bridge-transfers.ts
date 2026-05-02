import { hexlify, toUtf8Bytes, JsonRpcProvider, Contract } from "ethers";
import {
  getChainByDomain,
  getChainByChainId,
  getWorkingProvider,
  MESSAGE_TRANSMITTER_V2_ABI,
} from "./cctp-config";

/**
 * Bridge transfer persistence API client.
 *
 * Source of truth is server-side Redis via `/api/bridge-transfers`.
 * We keep a tiny local fallback cache only for degraded/offline scenarios.
 */

export interface PendingBridgeTransfer {
  id: string; // canonical burn tx hash (lowercase)
  burnTxHash: string;
  sourceDomain: number;
  sourceChainId: number;
  destDomain: number;
  destChainId: number;
  amount: string;
  userAddress: string;
  timestamp: number;
  updatedAt?: number;
  attestation?: {
    message: string;
    attestation: string;
  };
  status: "attesting" | "ready_to_mint" | "minting" | "complete" | "failed";
  mintTxHash?: string;
  error?: string;
}

const FALLBACK_STORAGE_KEY = "achswap_bridge_pending_transfers_fallback";
const HISTORY_STORAGE_KEY = "achswap_bridge_transfer_history";
const OWNERSHIP_INTENT = "bridge_transfer_mutation";
const OWNERSHIP_PROOF_TTL_MS = 10 * 60_000;
const OWNERSHIP_PROOF_CLOCK_SKEW_MS = 30_000;
const RECONCILIATION_CACHE_TTL_MS = 30_000; // 30 seconds cache for reconciliation results

const ownershipProofCacheByTransferId = new Map<string, {
  signedMessage: string;
  signature: string;
  issuedAt: number;
  expiresAt: number;
}>();

const reconciliationCache = new Map<string, { claimed: boolean; checkedAt: number }>();

function canonicalHash(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function canonicalAddress(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function hasTrustedBridgeStorage(storage: unknown): boolean {
  const normalized = String(storage || "").trim().toLowerCase();
  if (normalized === "redis") return true;

  // Local dev commonly runs a single long-lived process, so the memory
  // fallback is usable there. On serverless deployments it is not durable.
  if (normalized === "memory" && typeof window !== "undefined") {
    const hostname = window.location.hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  }

  return false;
}

export function getTransferStatusRank(status: string | null | undefined): number {
  switch (String(status || "").toLowerCase()) {
    case "attesting":
      return 1;
    case "ready_to_mint":
      return 2;
    case "minting":
      return 3;
    case "complete":
    case "completed":
      return 4;
    case "failed":
      return 5;
    default:
      return 0;
  }
}

function normalizeTransfer(transfer: PendingBridgeTransfer): PendingBridgeTransfer {
  return {
    ...transfer,
    id: canonicalHash(transfer.id || transfer.burnTxHash),
    burnTxHash: canonicalHash(transfer.burnTxHash),
    userAddress: canonicalAddress(transfer.userAddress),
  };
}

export function dispatchTransfersUpdated(): void {
  window.dispatchEvent(new CustomEvent("bridge-transfers-updated"));
}

export function getFallbackTransfers(): PendingBridgeTransfer[] {
  try {
    const LEGACY_KEY = "achswap_bridge_pending_transfers";
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    const currentRaw = localStorage.getItem(FALLBACK_STORAGE_KEY);
    let merged: PendingBridgeTransfer[] = [];

    // Load legacy entries first
    if (legacyRaw) {
      const legacyParsed = JSON.parse(legacyRaw) as PendingBridgeTransfer[];
      if (Array.isArray(legacyParsed)) merged = legacyParsed.map(normalizeTransfer);
    }

    // Merge with current fallback entries, dedupe by id
    if (currentRaw) {
      const currentParsed = JSON.parse(currentRaw) as PendingBridgeTransfer[];
      if (Array.isArray(currentParsed)) {
        const ids = new Set(merged.map(t => t.id));
        currentParsed.forEach(t => {
          const normalized = normalizeTransfer(t);
          if (!ids.has(normalized.id)) {
            merged.push(normalized);
            ids.add(normalized.id);
          }
        });
      }
    }

    // Save merged back only when migrating legacy entries.
    if (legacyRaw) {
      try {
        localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(merged.map(normalizeTransfer)));
        localStorage.removeItem(LEGACY_KEY);
      } catch (error) {
        console.warn("[bridge-transfers] failed to persist fallback migration", error);
      }
    }

    return merged;
  } catch {
    return [];
  }
}

export function setFallbackTransfers(transfers: PendingBridgeTransfer[]): void {
  try {
    localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(transfers.map(normalizeTransfer)));
  } catch {
    // ignore fallback storage write errors
  }
}

function mergeFallbackTransfersForWallet(
  userAddress: string,
  walletTransfers: PendingBridgeTransfer[],
): PendingBridgeTransfer[] {
  const wallet = canonicalAddress(userAddress);
  const normalizedServerTransfers = walletTransfers.map(normalizeTransferWithTimestamp);
  const existing = getFallbackTransfers();
  const others = existing.filter((tx) => canonicalAddress(tx.userAddress) !== wallet);
  const walletsExisting = existing.filter((tx) => canonicalAddress(tx.userAddress) === wallet);

  const byHash = new Map<string, PendingBridgeTransfer>();
  for (const tx of walletsExisting) {
    const hash = canonicalHash(tx.burnTxHash || tx.id);
    byHash.set(hash, normalizeTransferWithTimestamp(tx));
  }

  const serverByHash = new Map<string, PendingBridgeTransfer>();
  for (const tx of normalizedServerTransfers) {
    const hash = canonicalHash(tx.burnTxHash || tx.id);
    serverByHash.set(hash, tx);
  }

  const result: PendingBridgeTransfer[] = [];

  for (const [hash, serverTx] of serverByHash) {
    const local = byHash.get(hash);
    if (local) {
      byHash.delete(hash);
      result.push(resolveTransferConflict(local, serverTx));
    } else {
      result.push(serverTx);
    }
  }

  const pendingLocals = [...byHash.values()].filter(
    (tx) => tx.status !== "complete" && tx.status !== "failed",
  );
  return [...result, ...pendingLocals, ...others];
}

function normalizeTransferWithTimestamp(transfer: PendingBridgeTransfer): PendingBridgeTransfer {
  const normalized = normalizeTransfer(transfer);
  if (!normalized.updatedAt) {
    normalized.updatedAt = normalized.timestamp;
  }
  return normalized;
}

function resolveTransferConflict(
  local: PendingBridgeTransfer,
  server: PendingBridgeTransfer,
): PendingBridgeTransfer {
  const localUpdated = local.updatedAt || local.timestamp;
  const serverUpdated = server.updatedAt || server.timestamp;

  if (serverUpdated >= localUpdated) {
    return {
      ...server,
      id: local.id,
      burnTxHash: local.burnTxHash,
      userAddress: local.userAddress,
    };
  }

  return {
    ...local,
    status: server.status,
    mintTxHash: server.mintTxHash || local.mintTxHash,
    error: server.error || local.error,
  };
}

function getHistoryTransfers(): PendingBridgeTransfer[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingBridgeTransfer[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTransfer);
  } catch {
    return [];
  }
}

function setHistoryTransfers(transfers: PendingBridgeTransfer[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(transfers.map(normalizeTransfer)));
  } catch {}
}

export function addToHistory(transfer: PendingBridgeTransfer): void {
  const history = getHistoryTransfers();
  const normalized = normalizeTransfer(transfer);
  const existingIndex = history.findIndex(
    (t) => canonicalHash(t.burnTxHash || t.id) === canonicalHash(normalized.burnTxHash || normalized.id),
  );
  if (existingIndex >= 0) {
    history[existingIndex] = { ...history[existingIndex], ...normalized };
  } else {
    history.unshift(normalized);
  }
  const limited = history.slice(0, 100);
  setHistoryTransfers(limited);
}

function isOwnershipAction(status: PendingBridgeTransfer["status"] | undefined): boolean {
  return (
    status === "ready_to_mint"
    || status === "minting"
    || status === "attesting"
    || status === "complete"
    || status === "failed"
  );
}

function getCachedOwnershipProof(burnTxHash: string): {
  signedMessage: string;
  signature: string;
  issuedAt: number;
} | null {
  const transferKey = canonicalHash(burnTxHash);
  const cached = ownershipProofCacheByTransferId.get(transferKey);
  if (!cached) return null;

  const now = Date.now();
  if (cached.expiresAt <= now + OWNERSHIP_PROOF_CLOCK_SKEW_MS) {
    ownershipProofCacheByTransferId.delete(transferKey);
    return null;
  }

  return {
    signedMessage: cached.signedMessage,
    signature: cached.signature,
    issuedAt: cached.issuedAt,
  };
}

export function getPendingTransfers(): PendingBridgeTransfer[] {
  return getFallbackTransfers();
}

export function getResumableTransfers(userAddress?: string): PendingBridgeTransfer[] {
  const wallet = canonicalAddress(userAddress || "");
  return getFallbackTransfers().filter((tx) => {
    if (wallet && canonicalAddress(tx.userAddress) !== wallet) return false;
    return tx.status === "attesting" || tx.status === "ready_to_mint";
  });
}

export function getCachedPendingTransfersForWallet(userAddress: string): PendingBridgeTransfer[] {
  const wallet = canonicalAddress(userAddress);
  if (!wallet) return [];
  return getFallbackTransfers().filter((tx) => canonicalAddress(tx.userAddress) === wallet);
}

export function getTransferHistory(): PendingBridgeTransfer[] {
  return getHistoryTransfers();
}

export function getCachedHistoryForWallet(userAddress: string): PendingBridgeTransfer[] {
  const wallet = canonicalAddress(userAddress);
  if (!wallet) return [];
  return getHistoryTransfers().filter((tx) => canonicalAddress(tx.userAddress) === wallet);
}

export async function isBridgeTransferApiAvailable(userAddress: string): Promise<boolean> {
  const wallet = canonicalAddress(userAddress);
  if (!wallet) return false;

  try {
    const res = await fetch(`/api/bridge-transfers?probe=1&wallet=${encodeURIComponent(wallet)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return false;
    const data = await parseResponseJson(res);
    return hasTrustedBridgeStorage(data?.storage);
  } catch {
    return false;
  }
}

async function createOwnershipProof(burnTxHash: string, expectedOwner?: string): Promise<{
  signedMessage: string;
  signature: string;
  issuedAt: number;
} | null> {
  const ethereumProvider = (window as Window & {
    ethereum?: { request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown> };
  }).ethereum;

  if (!ethereumProvider) return null;

  const transferKey = canonicalHash(burnTxHash);
  const now = Date.now();
  const issuedAt = now;
  const payload = {
    intent: OWNERSHIP_INTENT,
    burnTxHash: canonicalHash(burnTxHash),
    issuedAt,
    expiresAt: issuedAt + OWNERSHIP_PROOF_TTL_MS,
  };
  const signedMessage = JSON.stringify(payload);

  try {
    const accounts = await ethereumProvider.request({ method: "eth_accounts" }) as string[];
    if (!Array.isArray(accounts) || accounts.length === 0 || !accounts[0]) {
      return null;
    }
    const signer = accounts[0];
    if (expectedOwner && canonicalAddress(signer) !== canonicalAddress(expectedOwner)) {
      console.warn(`[bridge-transfers] Ownership proof: signer ${signer} does not match expected owner ${expectedOwner}`);
      return null;
    }
    const messageHex = hexlify(toUtf8Bytes(signedMessage));
    const signature = await ethereumProvider.request({
      method: "personal_sign",
      params: [messageHex, signer],
    });

    if (typeof signature !== "string" || !signature) return null;

    const expiresAt = issuedAt + OWNERSHIP_PROOF_TTL_MS;
    ownershipProofCacheByTransferId.set(transferKey, {
      signedMessage,
      signature,
      issuedAt,
      expiresAt,
    });

    return {
      signedMessage,
      signature,
      issuedAt,
    };
  } catch {
    return null;
  }
}

async function parseResponseJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Extract CCTP message nonce from an attestation message.
 * The nonce is at bytes 12-44 (after the 0x prefix + 12-byte padding).
 */
function extractCctpNonce(message: string): string | null {
  const normalized = String(message || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(normalized)) return null;
  const start = 2 + 12 * 2; // Skip "0x" + 12 bytes (24 chars)
  const end = start + 32 * 2; // nonce is 32 bytes (64 chars)
  if (normalized.length < end) return null;
  return `0x${normalized.slice(start, end)}`;
}

/**
 * Check if a transfer's nonce has been used on the destination chain.
 * This indicates the transfer has been claimed/minted.
 */
async function checkIfClaimed(transfer: PendingBridgeTransfer): Promise<boolean> {
  if (!transfer.attestation?.message) return false;
  if (!transfer.destDomain && !transfer.destChainId) return false;

  // Check cache first
  const cached = reconciliationCache.get(transfer.id);
  if (cached && Date.now() - cached.checkedAt < RECONCILIATION_CACHE_TTL_MS) {
    return cached.claimed;
  }

  const chain = transfer.destDomain
    ? getChainByDomain(transfer.destDomain)
    : transfer.destChainId
      ? getChainByChainId(transfer.destChainId)
      : undefined;

  if (!chain) {
    console.warn(`[bridge-reconcile] Unknown destination chain for transfer ${transfer.id}`);
    return false;
  }

  const nonce = extractCctpNonce(transfer.attestation.message);
  if (!nonce) return false;

  try {
    const provider = await getWorkingProvider(chain);
    const contract = new Contract(
      chain.messageTransmitterV2,
      MESSAGE_TRANSMITTER_V2_ABI,
      provider,
    );
    const nonceState = await contract.usedNonces(nonce);
    const claimed = BigInt(nonceState) > 0n;

    // Cache the result
    reconciliationCache.set(transfer.id, { claimed, checkedAt: Date.now() });

    return claimed;
  } catch (err) {
    console.warn(`[bridge-reconcile] Failed to check nonce for ${transfer.id}:`, err);
    return false;
  }
}

/**
 * Reconcile a single transfer against the blockchain.
 * If the transfer is actually complete on-chain but shows as pending locally,
 * this will update it to "complete".
 */
export async function reconcileTransfer(
  transfer: PendingBridgeTransfer,
): Promise<PendingBridgeTransfer> {
  // Only reconcile transfers that should be complete
  const pendingStatuses = ["attesting", "ready_to_mint", "minting"];
  if (!pendingStatuses.includes(transfer.status)) {
    return transfer;
  }

  // Must have attestation to check
  if (!transfer.attestation?.message) {
    return transfer;
  }

  const claimed = await checkIfClaimed(transfer);
  if (!claimed) {
    return transfer;
  }

  console.log(`[bridge-reconcile] Transfer ${transfer.id} is claimed on-chain, updating to complete`);

  // Update local storage
  const existing = getFallbackTransfers();
  const idx = existing.findIndex((t) => t.id === transfer.id);
  if (idx >= 0) {
    existing[idx] = {
      ...existing[idx],
      status: "complete",
      error: undefined,
      updatedAt: Date.now(),
    };
    setFallbackTransfers(existing);
    dispatchTransfersUpdated();
  }

  // Try to update server
  try {
    const ownershipProof = getCachedOwnershipProof(transfer.id);
    if (ownershipProof) {
      await postBridgeTransfer("mark_complete", {
        burnTxHash: transfer.id,
        mintTxHash: transfer.mintTxHash,
        message: transfer.attestation?.message,
        attestation: transfer.attestation,
        userAddress: transfer.userAddress,
        sourceDomain: transfer.sourceDomain,
        sourceChainId: transfer.sourceChainId,
        destDomain: transfer.destDomain,
        destChainId: transfer.destChainId,
        amount: transfer.amount,
        timestamp: transfer.timestamp,
        ownershipProof,
      });
    }
  } catch (err) {
    console.warn(`[bridge-reconcile] Failed to update server for ${transfer.id}:`, err);
  }

  return {
    ...transfer,
    status: "complete",
    error: undefined,
  };
}

/**
 * Reconcile all pending transfers against the blockchain.
 * This will scan all pending transfers and update any that are actually complete.
 */
export async function reconcileAllPendingTransfers(
  userAddress: string,
): Promise<PendingBridgeTransfer[]> {
  const transfers = getFallbackTransfers().filter(
    (t) => canonicalAddress(t.userAddress) === canonicalAddress(userAddress),
  );

  const pending = transfers.filter((t) =>
    ["attesting", "ready_to_mint", "minting"].includes(t.status),
  );

  if (pending.length === 0) return transfers;

  console.log(`[bridge-reconcile] Checking ${pending.length} pending transfers against blockchain`);

  await Promise.allSettled(
    pending.map((t) => reconcileTransfer(t)),
  );

  // Return updated transfers
  return getFallbackTransfers().filter(
    (t) => canonicalAddress(t.userAddress) === canonicalAddress(userAddress),
  );
}

async function postBridgeTransfer(action: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/bridge-transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const data = await parseResponseJson(res);
      const message = data?.error || `Bridge transfer API error ${res.status}`;
      console.warn(`[bridge-transfers] ${action} failed: ${message}`);
      return false;
    }

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[bridge-transfers] ${action} request failed: ${message}`);
    return false;
  }
}

export async function fetchPendingTransfers(userAddress: string): Promise<PendingBridgeTransfer[]> {
  const wallet = canonicalAddress(userAddress);
  if (!wallet) return [];

  let serverTransfers: PendingBridgeTransfer[] = [];
  let serverFailed = false;
  try {
    const res = await fetch(`/api/bridge-transfers?wallet=${encodeURIComponent(wallet)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      try {
        const data = await parseResponseJson(res);
        if (hasTrustedBridgeStorage(data?.storage) && data && Array.isArray(data.transfers)) {
          serverTransfers = data.transfers.map((t: any) => normalizeTransfer(t));
        } else {
          serverFailed = true;
        }
      } catch {
        serverFailed = true;
      }
    } else {
      serverFailed = true;
    }
  } catch (e) {
    serverFailed = true;
    console.warn("[bridge] Failed to fetch from server, using local only", e);
  }

  // When server failed, don't overwrite local storage - just return existing local entries
  if (serverFailed) {
    const existing = getFallbackTransfers().filter(
      (tx) => canonicalAddress(tx.userAddress) === wallet
    );
    return existing.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  }

  // Only reconcile and persist when server response was trusted
  const merged = mergeFallbackTransfersForWallet(wallet, serverTransfers);
  
  const pending: PendingBridgeTransfer[] = [];
  for (const tx of merged) {
    if (tx.status === "complete" || tx.status === "failed") {
      addToHistory(tx);
    } else {
      pending.push(tx);
    }
  }

  const sorted = pending.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  setFallbackTransfers(sorted);

  // Run reconciliation in the background (don't block on this)
  void reconcileAllPendingTransfers(wallet).catch((err) => {
    console.warn("[bridge] Background reconciliation failed:", err);
  });

  return sorted;
}

export async function savePendingTransfer(
  transfer: PendingBridgeTransfer,
  options?: { strict?: boolean },
): Promise<boolean> {
  const normalized = normalizeTransfer(transfer);

  const existing = getFallbackTransfers();
  const idx = existing.findIndex((t) => t.id === normalized.id);
  if (idx >= 0) existing[idx] = normalized;
  else existing.unshift(normalized);
  setFallbackTransfers(existing);
  dispatchTransfersUpdated();

  const ok = await postBridgeTransfer("upsert_burn", {
    transfer: normalized,
  });

  if (!ok && options?.strict) {
    throw new Error("Failed to persist transfer to database");
  }

  return ok;
}

export async function updateTransferStatus(
  id: string,
  updates: Partial<PendingBridgeTransfer>,
): Promise<boolean> {
  const burnTxHash = canonicalHash(id);
  const status = updates.status;

  // Update local storage FIRST (don't let server failures block UI)
  const existing = getFallbackTransfers();
  const idx = existing.findIndex((t) => t.id === burnTxHash);
  if (idx >= 0) {
    const updatedRecord = {
      ...existing[idx],
      ...updates,
      id: existing[idx].id,
      burnTxHash: existing[idx].burnTxHash,
      userAddress: existing[idx].userAddress,
      updatedAt: Date.now(),
    };

    if (status === "complete" || status === "failed") {
      addToHistory(updatedRecord);
      existing.splice(idx, 1);
    } else {
      existing[idx] = updatedRecord;
    }
    setFallbackTransfers(existing);
    dispatchTransfersUpdated();
  }

  // Try to update server (non-blocking for UI)
  const requiresOwnership = isOwnershipAction(status);
  if (requiresOwnership) {
    const localRecord = existing.find((t) => t.id === burnTxHash) || 
      getFallbackTransfers().find((t) => t.id === burnTxHash);
    const expectedOwner = localRecord?.userAddress;
    let ownershipProof = getCachedOwnershipProof(burnTxHash);
    if (!ownershipProof) {
      ownershipProof = await createOwnershipProof(burnTxHash, expectedOwner);
    }

    if (!ownershipProof) {
      console.warn(`[bridge-transfers] ${status} skipped server update: missing ownership proof`);
      return true; // Local update already done
    }

    const ok = await postBridgeTransfer(
      status === "ready_to_mint" ? "update_attestation" :
      status === "minting" ? "mark_minting" :
      status === "complete" ? "mark_complete" :
      status === "failed" ? "mark_failed" :
      status === "attesting" ? "mark_attesting" : "",
      {
        burnTxHash,
        mintTxHash: updates.mintTxHash,
        message: updates.attestation?.message,
        attestation: updates.attestation,
        userAddress: localRecord?.userAddress,
        sourceDomain: localRecord?.sourceDomain,
        sourceChainId: localRecord?.sourceChainId,
        destDomain: localRecord?.destDomain,
        destChainId: localRecord?.destChainId,
        amount: localRecord?.amount,
        timestamp: localRecord?.timestamp,
        error: updates.error,
        ownershipProof,
      }
    );
    return ok;
  }

  // Non-ownership statuses (shouldn't normally happen)
  return true;
}

export async function removeTransfer(id: string): Promise<boolean> {
  const burnTxHash = canonicalHash(id);

  const localTransfers = getFallbackTransfers();
  const localRecord = localTransfers.find((t) => t.id === burnTxHash);
  if (!localRecord) {
    return false;
  }

  if (localRecord.status !== "failed" && localRecord.status !== "complete") {
    return false;
  }

  let serverConfirmedAbsent = false;
  try {
    const wallet = canonicalAddress(localRecord.userAddress);
    const res = await fetch(`/api/bridge-transfers?wallet=${encodeURIComponent(wallet)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await parseResponseJson(res);
      const serverTransfers = Array.isArray(data?.transfers) ? data.transfers : [];
      serverConfirmedAbsent = !serverTransfers.some((t: any) => canonicalHash(t?.burnTxHash || t?.id) === burnTxHash);
    }
  } catch {
    // Network error: cannot confirm server state, fall through to server dismiss
  }

  if (serverConfirmedAbsent) {
    if (localRecord) {
      addToHistory(localRecord);
    }
    const filteredLocal = localTransfers.filter((t) => t.id !== burnTxHash);
    setFallbackTransfers(filteredLocal);
    dispatchTransfersUpdated();
    return true;
  }

  let ownershipProof = getCachedOwnershipProof(burnTxHash);
  if (!ownershipProof) {
    ownershipProof = await createOwnershipProof(burnTxHash, localRecord?.userAddress);
  }

  if (!ownershipProof) {
    return false;
  }

  const ok = await postBridgeTransfer("dismiss", { burnTxHash, ownershipProof });

  if (!ok) {
    return false;
  }

  if (localRecord) {
    addToHistory(localRecord);
  }

  const filtered = getFallbackTransfers().filter((t) => t.id !== burnTxHash);
  setFallbackTransfers(filtered);
  dispatchTransfersUpdated();
  return ok;
}
