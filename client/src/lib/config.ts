import { BrowserProvider } from "ethers";

const alchemyKey = import.meta.env.VITE_ALCHEMY_KEY;

export const RPC_CONFIG = {
  arcTestnet: alchemyKey 
    ? `https://arc-testnet.g.alchemy.com/v2/${alchemyKey}`
    : 'https://rpc.testnet.arc.network',
  stableTestnet: 'https://rpc.testnet.stable.xyz/',
};

export const getRpcUrl = (chainId: number): string => {
  return chainId === 2201 ? RPC_CONFIG.stableTestnet : RPC_CONFIG.arcTestnet;
};

export const FALLBACK_RPC = 'https://rpc.testnet.arc.network';

export function createAlchemyProvider(chainId: number): BrowserProvider {
  const rpcUrl = getRpcUrl(chainId);
  const fallbackRpcUrl = chainId === 2201 ? getRpcUrl(2201) : FALLBACK_RPC;
  const useFallback = rpcUrl !== fallbackRpcUrl;

  return new BrowserProvider({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      const requestOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      };

      try {
        if (useFallback) {
          const res = await fetch(rpcUrl, requestOptions);
          const json = await res.json();
          if (json.error) throw new Error(json.error.message ?? "RPC error");
          return json.result;
        } else {
          const res = await fetchWithRetry(rpcUrl, requestOptions, 3);
          const json = await res.json();
          if (json.error) throw new Error(json.error.message ?? "RPC error");
          return json.result;
        }
      } catch (err) {
        if (useFallback) {
          console.warn(`Primary RPC failed, trying fallback: ${fallbackRpcUrl}`);
          const res = await fetch(fallbackRpcUrl, requestOptions);
          const json = await res.json();
          if (json.error) throw new Error(json.error.message ?? "RPC error");
          return json.result;
        }
        throw new Error("All RPC endpoints failed");
      }
    },
  });
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
