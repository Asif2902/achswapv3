import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  injectedWallet,
  metaMaskWallet,
  coinbaseWallet,
  rabbyWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { createTransport, defineChain } from 'viem';
import {
  ARC_TESTNET_CHAIN_ID,
  getManagedRpcAttempts,
  getRpcUrl,
  getRpcUrls,
  reportRpcFailure,
  isRetryableRpcError,
} from './config';

const ARC_WALLET_ADD_RPC = getRpcUrl(ARC_TESTNET_CHAIN_ID);

// Define ARC Testnet chain
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'ARC Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'USDC',
    symbol: 'USDC',
  },
  rpcUrls: {
    default: {
      http: [ARC_WALLET_ADD_RPC],
    },
    public: {
      http: [ARC_WALLET_ADD_RPC],
    },
  },
  blockExplorers: {
    default: { name: 'ARCscan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
});

// Multichain support - add more chains here in the future
export const supportedChains = [arcTestnet];

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
if (!projectId) {
  throw new Error('Missing VITE_WALLETCONNECT_PROJECT_ID environment variable');
}

const browserWallets = [injectedWallet, metaMaskWallet, coinbaseWallet, rabbyWallet];
const otherWallets = [walletConnectWallet];

const connectors = connectorsForWallets(
  [
    { groupName: 'Browser Wallets', wallets: browserWallets },
    { groupName: 'Other', wallets: otherWallets },
  ],
  { appName: 'Achswap', projectId }
);

const transportCache = new Map<string, ReturnType<typeof http>>();

function createManagedHttpTransport(chainId: number) {
  return ((params: any) =>
    createTransport(
      {
        key: 'managedHttp',
        name: 'Managed HTTP',
        retryCount: 0,
        type: 'managedHttp',
        request: (async ({ method, params: rpcParams }: any) => {
          let lastError: unknown = null;
          const attempts = getManagedRpcAttempts(chainId);

          if (attempts.length === 0) {
            throw new Error(`RPC transport failed for chain ${chainId}: no RPC attempts configured`);
          }

          for (const attempt of attempts) {
            const transportCacheKey = `${attempt.url}::${attempt.timeoutMs}`;
            let transport = transportCache.get(transportCacheKey);
            if (!transport) {
              transport = http(attempt.url, {
                batch: { batchSize: 20, wait: 10 },
                retryCount: 0,
                timeout: attempt.timeoutMs,
              });
              transportCache.set(transportCacheKey, transport);
            }
            const transportInstance = transport(params);

            try {
              return await transportInstance.request({ method, params: rpcParams } as any);
            } catch (error) {
              // Rethrow non-retryable errors
              if (!isRetryableRpcError(error)) {
                throw error;
              }
              lastError = error;
              reportRpcFailure(chainId, attempt.url);
            }
          }

          if (lastError == null) {
            throw new Error(`RPC transport failed for chain ${chainId}: all attempts exhausted without an error`);
          }

          throw new Error(`RPC transport failed for chain ${chainId}`, { cause: lastError });
        }) as any,
      },
      { get urls() { return getRpcUrls(chainId); } },
    )) as any;
}

export const config = createConfig({
  connectors,
  chains: supportedChains as any,
  transports: {
    [arcTestnet.id]: createManagedHttpTransport(ARC_TESTNET_CHAIN_ID),
  },
});
