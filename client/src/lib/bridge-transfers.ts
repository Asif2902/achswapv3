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
  attestation?: {
    message: string;
    attestation: string;
  };
  status: "attesting" | "ready_to_mint" | "minting" | "complete" | "failed";
  mintTxHash?: string;
  error?: string;
}

const FALLBACK_STORAGE_KEY = "achswap_bridge_pending_transfers_fallback";
const OWNERSHIP_INTENT = "bridge_transfer_mutation";
const OWNERSHIP_PROOF_TTL_MS = 10 * 60_000;
const OWNERSHIP_PROOF_CLOCK_SKEW_MS = 30_000;

const ownershipProofCacheByTransferId = new Map<string, {
  signedMessage: string;
  signature: string;
  issuedAt: number;
  expiresAt: number;
}>();

function canonicalHash(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function canonicalAddress(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeTransfer(transfer: PendingBridgeTransfer): PendingBridgeTransfer {
  return {
    ...transfer,
    id: canonicalHash(transfer.id || transfer.burnTxHash),
    burnTxHash: canonicalHash(transfer.burnTxHash),
    userAddress: canonicalAddress(transfer.userAddress),
  };
}

function dispatchTransfersUpdated(): void {
  window.dispatchEvent(new CustomEvent("bridge-transfers-updated"));
}

function getFallbackTransfers(): PendingBridgeTransfer[] {
  try {
    const raw = localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingBridgeTransfer[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTransfer);
  } catch {
    return [];
  }
}

function setFallbackTransfers(transfers: PendingBridgeTransfer[]): void {
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
  const normalizedWalletTransfers = walletTransfers.map(normalizeTransfer);
  const existing = getFallbackTransfers();
  const others = existing.filter((tx) => canonicalAddress(tx.userAddress) !== wallet);
  return [...normalizedWalletTransfers, ...others];
}

function isOwnershipAction(status: PendingBridgeTransfer["status"] | undefined): boolean {
  return (
    status === "ready_to_mint"
    || status === "minting"
    || status === "attesting"
    || status === "failed"
    || status === "complete"
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

export async function isBridgeTransferApiAvailable(userAddress: string): Promise<boolean> {
  const wallet = canonicalAddress(userAddress);
  if (!wallet) return false;

  try {
    const res = await fetch(`/api/bridge-transfers?probe=1&wallet=${encodeURIComponent(wallet)}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function createOwnershipProof(burnTxHash: string): Promise<{
  signedMessage: string;
  signature: string;
  issuedAt: number;
} | null> {
  const ethereumProvider = (window as Window & {
    ethereum?: { request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown> };
  }).ethereum;

  if (!ethereumProvider) return null;

  const now = Date.now();
  const transferKey = canonicalHash(burnTxHash);
  const cached = getCachedOwnershipProof(transferKey);
  if (cached) return cached;

  const issuedAt = now;
  const payload = {
    intent: OWNERSHIP_INTENT,
    burnTxHash: canonicalHash(burnTxHash),
    issuedAt,
    expiresAt: issuedAt + OWNERSHIP_PROOF_TTL_MS,
  };
  const signedMessage = JSON.stringify(payload);

  try {
    const signature = await ethereumProvider.request({
      method: "personal_sign",
      params: [signedMessage],
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

async function postBridgeTransfer(action: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/bridge-transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
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

  const res = await fetch(`/api/bridge-transfers?wallet=${encodeURIComponent(wallet)}`);
  if (!res.ok) {
    const data = await parseResponseJson(res);
    const message = data?.error || `Bridge transfer API error ${res.status}`;
    throw new Error(message);
  }

  const data = await parseResponseJson(res);
  const transfers = Array.isArray(data?.transfers)
    ? (data.transfers as PendingBridgeTransfer[]).map(normalizeTransfer)
    : [];

  const merged = mergeFallbackTransfersForWallet(wallet, transfers);
  setFallbackTransfers(merged);
  return transfers;
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
  let ok = true;
  const requiresOwnership = isOwnershipAction(status);
  let hasOwnershipProof = !requiresOwnership;
  let ownershipProof: { signedMessage: string; signature: string; issuedAt: number } | null = null;

  if (requiresOwnership) {
    ownershipProof = getCachedOwnershipProof(burnTxHash);
    if (!ownershipProof) {
      ownershipProof = await createOwnershipProof(burnTxHash);
    }

    if (!ownershipProof) {
      console.warn(`[bridge-transfers] ${status} skipped: missing ownership proof`);
      hasOwnershipProof = false;
    }

    if (!hasOwnershipProof) {
      return false;
    }
  }

  if (status === "ready_to_mint") {
    ok = ok && await postBridgeTransfer("update_attestation", {
      burnTxHash,
      attestation: updates.attestation,
      destDomain: updates.destDomain,
      destChainId: updates.destChainId,
      error: updates.error,
      ownershipProof,
    });
  } else if (status === "minting") {
    ok = ok && await postBridgeTransfer("mark_minting", {
      burnTxHash,
      ownershipProof,
    });
  } else if (status === "complete") {
    ok = ok && await postBridgeTransfer("mark_complete", {
      burnTxHash,
      mintTxHash: updates.mintTxHash,
      message: updates.attestation?.message,
      ownershipProof,
    });
  } else if (status === "failed") {
    ok = ok && await postBridgeTransfer("mark_failed", {
      burnTxHash,
      error: updates.error,
      ownershipProof,
    });
  } else if (status === "attesting") {
    ok = ok && await postBridgeTransfer("mark_attesting", {
      burnTxHash,
      error: updates.error,
      ownershipProof,
    });
  }

  const existing = getFallbackTransfers();
  const idx = existing.findIndex((t) => t.id === burnTxHash);
  const canApplyLocal = status !== "complete" || ok;
  if (idx >= 0 && canApplyLocal) {
    existing[idx] = {
      ...existing[idx],
      ...updates,
      id: existing[idx].id,
      burnTxHash: existing[idx].burnTxHash,
      userAddress: existing[idx].userAddress,
    };
    setFallbackTransfers(existing);
  }
  if (idx >= 0 && canApplyLocal) {
    dispatchTransfersUpdated();
  }
  return ok;
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

  let existsOnServer = true;
  try {
    const wallet = canonicalAddress(localRecord.userAddress);
    const res = await fetch(`/api/bridge-transfers?wallet=${encodeURIComponent(wallet)}`);
    if (res.ok) {
      const data = await parseResponseJson(res);
      const serverTransfers = Array.isArray(data?.transfers) ? data.transfers : [];
      existsOnServer = serverTransfers.some((t: any) => canonicalHash(t?.burnTxHash || t?.id) === burnTxHash);
    } else {
      existsOnServer = false;
    }
  } catch {
    existsOnServer = false;
  }

  if (!existsOnServer) {
    const filteredLocal = localTransfers.filter((t) => t.id !== burnTxHash);
    setFallbackTransfers(filteredLocal);
    dispatchTransfersUpdated();
    return true;
  }

  let ownershipProof = getCachedOwnershipProof(burnTxHash);
  if (!ownershipProof) {
    ownershipProof = await createOwnershipProof(burnTxHash);
  }

  if (!ownershipProof) {
    const filteredLocal = localTransfers.filter((t) => t.id !== burnTxHash);
    setFallbackTransfers(filteredLocal);
    dispatchTransfersUpdated();
    return true;
  }

  const ok = await postBridgeTransfer("dismiss", { burnTxHash, ownershipProof });

  if (!ok) {
    return false;
  }

  const filtered = getFallbackTransfers().filter((t) => t.id !== burnTxHash);
  setFallbackTransfers(filtered);
  dispatchTransfersUpdated();
  return ok;
}
