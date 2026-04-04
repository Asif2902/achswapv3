import { JsonRpcProvider, Network } from "ethers";
import type { JsonRpcPayload, JsonRpcResult } from "ethers";

const alchemyKey = import.meta.env.VITE_ALCHEMY_KEY;

export const RPC_CONFIG = {
  arcTestnet: alchemyKey 
    ? `https://arc-testnet.g.alchemy.com/v2/${alchemyKey}`
    : 'https://rpc.testnet.arc.network',
  // Add more chains here, e.g.:
  // mainnet: 'https://...',
};

export const getRpcUrl = (chainId: number): string => {
  // Extend this switch for multi-chain support
  return RPC_CONFIG.arcTestnet;
};

export const FALLBACK_RPC = 'https://rpc.testnet.arc.network';

// ─── JSON-RPC provider with primary/fallback (NO batching) ────────────────────
//
// Alchemy explicitly states: "batch requests can be less reliable compared to
// individual API calls" (docs.alchemy.com/docs/reference/batch-requests).
//
// batchMaxCount: 1 disables ethers' auto-batching entirely. Each RPC call
// becomes its own HTTP request, which Alchemy handles reliably.
// batchStallTime: 0 means no delay — flush immediately.
// staticNetwork: skips the automatic eth_chainId probe on every provider creation
//
// Fallback: if the primary (Alchemy) call fails, we retry against the public
// ARC RPC.

class ReliableRpcProvider extends JsonRpcProvider {
  private _fallbackUrl: string;
  private _primaryUrl: string;

  constructor(primaryUrl: string, fallbackUrl: string, network: Network) {
    super(primaryUrl, network, {
      batchMaxCount: 1,
      batchStallTime: 0,
      staticNetwork: network,
    });
    this._primaryUrl = primaryUrl;
    this._fallbackUrl = fallbackUrl;
  }

  async _send(payload: Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    try {
      return await super._send(payload);
    } catch (err) {
      if (this._fallbackUrl && this._fallbackUrl !== this._primaryUrl) {
        console.warn(
          `Primary RPC failed, trying fallback: ${this._fallbackUrl}`,
        );
        const body = JSON.stringify(payload.length === 1 ? payload[0] : payload);
        const res = await fetch(this._fallbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const json = await res.json();
        return Array.isArray(json) ? json : [json];
      }
      throw err;
    }
  }
}

// Network instances are cached per chainId to avoid re-creating them.
const networkCache = new Map<number, Network>();

function getNetwork(chainId: number): Network {
  let network = networkCache.get(chainId);
  if (!network) {
    network = Network.from(chainId);
    networkCache.set(chainId, network);
  }
  return network;
}

/**
 * Create a read-only JSON-RPC provider with individual (non-batched) requests.
 *
 * Each RPC call is its own HTTP request — Alchemy handles this reliably.
 * Retains primary → fallback RPC behaviour.
 */
export function createAlchemyProvider(chainId: number): JsonRpcProvider {
  const primaryUrl = getRpcUrl(chainId);
  const network = getNetwork(chainId);
  return new ReliableRpcProvider(primaryUrl, FALLBACK_RPC, network);
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e as Error;
    }
  }
  
  throw lastError || new Error('Fetch failed');
}
