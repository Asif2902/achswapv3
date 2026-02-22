const alchemyKey = import.meta.env.VITE_ALCHEMY_KEY;

if (!alchemyKey) {
  console.warn('VITE_ALCHEMY_KEY is not set. RPC calls may fail.');
}

export const RPC_CONFIG = {
  arcTestnet: alchemyKey 
    ? `https://arc-testnet.g.alchemy.com/v2/${alchemyKey}`
    : 'https://rpc.testnet.arc.network',
  stableTestnet: 'https://rpc.testnet.stable.xyz/',
};

export const getRpcUrl = (chainId: number): string => {
  return chainId === 2201 ? RPC_CONFIG.stableTestnet : RPC_CONFIG.arcTestnet;
};
