import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  injectedWallet,
  metaMaskWallet,
  coinbaseWallet,
  rabbyWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { defineChain } from 'viem';
import { RPC_CONFIG } from './config';

const ARC_WALLET_ADD_RPC = 'https://rpc.testnet.arc.network';

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

export const config = createConfig({
  connectors,
  chains: supportedChains as any,
  transports: {
    [arcTestnet.id]: http(),
  },
});
