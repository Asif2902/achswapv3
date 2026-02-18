export interface V2Contracts {
  factory: string;
  router: string;
}

export interface V3Contracts {
  factory: string;
  swapRouter: string;
  nonfungiblePositionManager: string;
  quoter02: string;
  migrator: string;
  positionDescriptor: string;
  tickLens: string;
}

export interface ChainContracts {
  v2: V2Contracts;
  v3: V3Contracts;
  explorer: string;
}

export const contractsByChainId: Record<number, ChainContracts> = {
  5042002: {
    v2: {
      factory: "0x7cC023C7184810B84657D55c1943eBfF8603B72B",
      router: "0xB92428D440c335546b69138F7fAF689F5ba8D436",
    },
    v3: {
      factory: "0x65fa500712D451b521bA114a4D3962565969F06a",
      swapRouter: "0x8ceD4213F72dEB449a9e2D9855bDF4b9e2e913B6",
      nonfungiblePositionManager: "0x6Fe6e80B655fDa474981e16EE43b12131C987d46",
      quoter02: "0xcC3d26f4811B6861cD8fD2BC547629D6701c6F5F",
      migrator: "0x859d886319C75eD6Ec3d9f31e8d68802Fdb04D1B",
      positionDescriptor: "0xB84c064010144a83d2D044A00395B7aDEd1101a3",
      tickLens: "0x3ac9B673114477CEf52bfc8E3f9a7dcb767C8c3a",
    },
    explorer: "https://testnet.arcscan.app/tx/"
  },
  // Add more chains here with their V2 and V3 contracts
};

export function getContractsForChain(chainId: number): ChainContracts {
  const contracts = contractsByChainId[chainId];
  if (!contracts) {
    throw new Error(`No contracts configured for chain ID ${chainId}`);
  }
  return contracts;
}
