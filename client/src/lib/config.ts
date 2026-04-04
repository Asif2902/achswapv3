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

// ─── JSON-RPC provider with primary/fallback (batched) ────────────────────────
//
// batchMaxCount: 20 — parallel Promise.all calls get packed into batches of 20.
// V3 quotes fire ~60 calls → 3 HTTP requests instead of 60.
// batchStallTime: 10ms — collects calls in the same event-loop tick.
// staticNetwork: skips the automatic eth_chainId probe on every provider creation
//
// Fallback: if the primary (Alchemy) call fails, we retry against the public
// ARC RPC.

class ReliableRpcProvider extends JsonRpcProvider {
  private _fallbackUrl: string;
  private _primaryUrl: string;

  constructor(primaryUrl: string, fallbackUrl: string, network: Network) {
    super(primaryUrl, network, {
      batchMaxCount: 20,
      batchStallTime: 10,
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
 * Create a read-only JSON-RPC provider with automatic request batching.
 *
 * When multiple eth_call / eth_getBalance / etc. are awaited together
 * (e.g. via Promise.all), they are packed into a single HTTP request.
 * This dramatically reduces latency for pages that load many pools or
 * positions in parallel.
 *
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

// Retry helper for flaky RPC calls — use for any contract method that may fail
export async function rpcWithRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 300): Promise<T> {
  let lastError: Error | unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}
