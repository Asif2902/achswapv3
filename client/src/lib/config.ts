const alchemyKey = import.meta.env.VITE_ALCHEMY_KEY;

export const RPC_CONFIG = {
  arcTestnet: `https://arc-testnet.g.alchemy.com/v2/${alchemyKey}`,
  stableTestnet: 'https://rpc.testnet.stable.xyz/',
};

export const getRpcUrl = (chainId: number): string => {
  return chainId === 2201 ? RPC_CONFIG.stableTestnet : RPC_CONFIG.arcTestnet;
};
