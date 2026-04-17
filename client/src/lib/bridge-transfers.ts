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
    const res = await fetch(`/api/bridge-transfers?wallet=${encodeURIComponent(wallet)}`);
    return res.ok;
  } catch {
    return false;
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

  setFallbackTransfers(transfers);
  return transfers;
}

export async function savePendingTransfer(
  transfer: PendingBridgeTransfer,
  options?: { strict?: boolean },
): Promise<boolean> {
  const normalized = normalizeTransfer(transfer);

  const ok = await postBridgeTransfer("upsert_burn", {
    transfer: normalized,
  });

  if (!ok && options?.strict) {
    throw new Error("Failed to persist transfer to database");
  }

  const existing = getFallbackTransfers();
  const idx = existing.findIndex((t) => t.id === normalized.id);
  if (idx >= 0) existing[idx] = normalized;
  else existing.unshift(normalized);
  setFallbackTransfers(existing);
  dispatchTransfersUpdated();

  return ok;
}

export async function updateTransferStatus(
  id: string,
  updates: Partial<PendingBridgeTransfer>,
): Promise<boolean> {
  const burnTxHash = canonicalHash(id);
  const status = updates.status;
  let ok = true;

  if (status === "ready_to_mint") {
    ok = await postBridgeTransfer("update_attestation", {
      burnTxHash,
      attestation: updates.attestation,
      destDomain: updates.destDomain,
      destChainId: updates.destChainId,
      error: updates.error,
    });
  } else if (status === "minting") {
    ok = await postBridgeTransfer("mark_minting", {
      burnTxHash,
    });
  } else if (status === "complete") {
    ok = await postBridgeTransfer("mark_complete", {
      burnTxHash,
      mintTxHash: updates.mintTxHash,
      message: updates.attestation?.message,
    });
  } else if (status === "failed") {
    ok = await postBridgeTransfer("mark_failed", {
      burnTxHash,
      error: updates.error,
    });
  } else if (status === "attesting") {
    ok = await postBridgeTransfer("mark_attesting", {
      burnTxHash,
      error: updates.error,
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
  const ok = await postBridgeTransfer("dismiss", { burnTxHash });

  if (!ok) {
    return false;
  }

  const filtered = getFallbackTransfers().filter((t) => t.id !== burnTxHash);
  setFallbackTransfers(filtered);
  dispatchTransfersUpdated();
  return ok;
}
