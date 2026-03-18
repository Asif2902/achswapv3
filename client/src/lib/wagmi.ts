import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet,
  coinbaseWallet,
  rabbyWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { defineChain } from 'viem';
import { RPC_CONFIG } from './config';
import { backpackWallet } from './backpackWallet';

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
      http: [RPC_CONFIG.arcTestnet],
    },
    public: {
      http: [RPC_CONFIG.arcTestnet],
    },
  },
  blockExplorers: {
    default: { name: 'ARCscan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
});

// Multichain support - add more chains here in the future
export const supportedChains = [arcTestnet];

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'demo-project-id-12345abcdef';

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Browser Wallets',
      wallets: [
        metaMaskWallet,
        coinbaseWallet,
        rabbyWallet,
        () => backpackWallet({ projectId }),
      ],
    },
    {
      groupName: 'Other',
      wallets: [walletConnectWallet],
    },
  ],
  {
    appName: 'Achswap',
    projectId,
  }
);

export const config = createConfig({
  connectors,
  chains: supportedChains as any,
  transports: {
    [arcTestnet.id]: http(),
  },
});
