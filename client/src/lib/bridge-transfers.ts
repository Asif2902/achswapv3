/**
 * Bridge Transfer Persistence
 * Saves incomplete bridge transfers to localStorage so users can resume them.
 * Transfers are saved after the burn tx succeeds, and removed after mint completes.
 */

export interface PendingBridgeTransfer {
  id: string; // unique identifier (burnTxHash)
  burnTxHash: string;
  sourceDomain: number;
  sourceChainId: number;
  destDomain: number;
  destChainId: number;
  amount: string; // human-readable
  userAddress: string;
  timestamp: number; // when the burn was submitted
  // attestation data (populated once attestation is received)
  attestation?: {
    message: string;
    attestation: string;
  };
  // status
  status: "attesting" | "ready_to_mint" | "minting" | "complete" | "failed";
  mintTxHash?: string;
  error?: string;
}

const STORAGE_KEY = "achswap_bridge_pending_transfers";

function canonicalTransferId(id: string): string {
  return id.trim().toLowerCase();
}

export function getPendingTransfers(): PendingBridgeTransfer[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const transfers: PendingBridgeTransfer[] = JSON.parse(raw);
    // Filter out completed transfers older than 24 hours, keep pending ones indefinitely
    const now = Date.now();
    const filtered = transfers.filter(t => {
      if (t.status === "complete") return now - t.timestamp < 24 * 60 * 60 * 1000;
      return true;
    });
    // Write the pruned list back so stale entries don't accumulate
    if (filtered.length !== transfers.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    }
    return filtered;
  } catch {
    return [];
  }
}

export function savePendingTransfer(transfer: PendingBridgeTransfer): void {
  const existing = getPendingTransfers();
  const normalizedId = canonicalTransferId(transfer.id);
  const idx = existing.findIndex(t => canonicalTransferId(t.id) === normalizedId);
  const normalizedTransfer: PendingBridgeTransfer = {
    ...transfer,
    id: normalizedId,
    burnTxHash: canonicalTransferId(transfer.burnTxHash),
  };
  if (idx >= 0) {
    existing[idx] = normalizedTransfer;
  } else {
    existing.unshift(normalizedTransfer); // newest first
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch (e) {
    console.warn(`[${STORAGE_KEY}] localStorage write failed:`, e);
  }
  // Dispatch a custom event so other components (Header) can react
  window.dispatchEvent(new CustomEvent("bridge-transfers-updated"));
}

export function updateTransferStatus(
  id: string,
  updates: Partial<PendingBridgeTransfer>
): void {
  const existing = getPendingTransfers();
  const normalizedId = canonicalTransferId(id);
  const idx = existing.findIndex(t => canonicalTransferId(t.id) === normalizedId);
  if (idx >= 0) {
    existing[idx] = {
      ...existing[idx],
      ...updates,
      id: existing[idx].id,
      burnTxHash:
        updates.burnTxHash !== undefined
          ? canonicalTransferId(updates.burnTxHash)
          : existing[idx].burnTxHash,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    } catch (e) {
      console.warn(`[${STORAGE_KEY}] localStorage write failed:`, e);
    }
    window.dispatchEvent(new CustomEvent("bridge-transfers-updated"));
  }
}

export function removeTransfer(id: string): void {
  const existing = getPendingTransfers();
  const normalizedId = canonicalTransferId(id);
  const filtered = existing.filter(t => canonicalTransferId(t.id) !== normalizedId);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.warn(`[${STORAGE_KEY}] localStorage write failed:`, e);
  }
  window.dispatchEvent(new CustomEvent("bridge-transfers-updated"));
}

export function getResumableTransfers(userAddress?: string): PendingBridgeTransfer[] {
  const all = getPendingTransfers();
  return all.filter(t => {
    if (userAddress) {
      // Defensively skip records with missing or malformed userAddress
      if (typeof t.userAddress !== "string" || t.userAddress.length === 0) return false;
      if (t.userAddress.toLowerCase() !== userAddress.toLowerCase()) return false;
    }
    return t.status === "attesting" || t.status === "ready_to_mint";
  });
}
