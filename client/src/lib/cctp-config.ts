/**
 * Circle CCTP (Cross-Chain Transfer Protocol) Configuration
 * Testnet chains only - all EVM-compatible testnets supported by CCTP V2
 * 
 * Contract addresses from: https://developers.circle.com/cctp/references/contract-addresses
 * Domain identifiers from: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 */

export interface CCTPChain {
  name: string;
  shortName: string;
  chainId: number;
  domain: number; // CCTP domain identifier (NOT chain ID)
  rpcUrl: string;
  explorerUrl: string;
  explorerTxPath: string; // e.g. "/tx/" 
  usdcAddress: string;
  tokenMessengerV2: string;
  messageTransmitterV2: string;
  usdcDecimals: number;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  logo: string; // path or URL
  color: string; // brand color for UI
  supportsFastTransfer: boolean;
}

// All testnet CCTP V2 contracts share the same addresses
const TESTNET_TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const TESTNET_MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

// CCTP Attestation API (sandbox/testnet)
export const CCTP_ATTESTATION_API = "https://iris-api-sandbox.circle.com";

export const CCTP_TESTNET_CHAINS: CCTPChain[] = [
  {
    name: "Arc Testnet",
    shortName: "Arc",
    chainId: 5042002,
    domain: 26,
    rpcUrl: "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    explorerTxPath: "/tx/",
    usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // USDC on Arc testnet (native gas token is also USDC)
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    logo: "/img/logos/arc-network.png",
    color: "#6366f1",
    supportsFastTransfer: false,
  },
  {
    name: "Ethereum Sepolia",
    shortName: "Sepolia",
    chainId: 11155111,
    domain: 0,
    rpcUrl: "https://rpc.sepolia.org",
    explorerUrl: "https://sepolia.etherscan.io",
    explorerTxPath: "/tx/",
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    logo: "",
    color: "#627EEA",
    supportsFastTransfer: true,
  },
  {
    name: "Avalanche Fuji",
    shortName: "Fuji",
    chainId: 43113,
    domain: 1,
    rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
    explorerUrl: "https://testnet.snowtrace.io",
    explorerTxPath: "/tx/",
    usdcAddress: "0x5425890298aed601595a70AB815c96711a31Bc65",
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    logo: "",
    color: "#E84142",
    supportsFastTransfer: false,
  },
  {
    name: "OP Sepolia",
    shortName: "OP Sep",
    chainId: 11155420,
    domain: 2,
    rpcUrl: "https://sepolia.optimism.io",
    explorerUrl: "https://sepolia-optimism.etherscan.io",
    explorerTxPath: "/tx/",
    usdcAddress: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    logo: "",
    color: "#FF0420",
    supportsFastTransfer: true,
  },
  {
    name: "Arbitrum Sepolia",
    shortName: "Arb Sep",
    chainId: 421614,
    domain: 3,
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerUrl: "https://sepolia.arbiscan.io",
    explorerTxPath: "/tx/",
    usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    logo: "",
    color: "#28A0F0",
    supportsFastTransfer: true,
  },
  {
    name: "Base Sepolia",
    shortName: "Base Sep",
    chainId: 84532,
    domain: 6,
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://base-sepolia.blockscout.com",
    explorerTxPath: "/tx/",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    logo: "",
    color: "#0052FF",
    supportsFastTransfer: true,
  },
  {
    name: "Polygon Amoy",
    shortName: "Amoy",
    chainId: 80002,
    domain: 7,
    rpcUrl: "https://rpc-amoy.polygon.technology",
    explorerUrl: "https://amoy.polygonscan.com",
    explorerTxPath: "/tx/",
    usdcAddress: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    logo: "",
    color: "#8247E5",
    supportsFastTransfer: false,
  },
  {
    name: "Unichain Sepolia",
    shortName: "Uni Sep",
    chainId: 1301,
    domain: 10,
    rpcUrl: "https://sepolia.unichain.org",
    explorerUrl: "https://unichain-sepolia.blockscout.com",
    explorerTxPath: "/tx/",
    usdcAddress: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    logo: "",
    color: "#FF007A",
    supportsFastTransfer: true,
  },
  {
    name: "Linea Sepolia",
    shortName: "Linea Sep",
    chainId: 59141,
    domain: 11,
    rpcUrl: "https://rpc.sepolia.linea.build",
    explorerUrl: "https://sepolia.lineascan.build",
    explorerTxPath: "/tx/",
    usdcAddress: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
    tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2,
    messageTransmitterV2: TESTNET_MESSAGE_TRANSMITTER_V2,
    usdcDecimals: 6,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    logo: "",
    color: "#61DFFF",
    supportsFastTransfer: true,
  },
];

// Helper to find a chain by domain
export function getChainByDomain(domain: number): CCTPChain | undefined {
  return CCTP_TESTNET_CHAINS.find(c => c.domain === domain);
}

// Helper to find a chain by chainId
export function getChainByChainId(chainId: number): CCTPChain | undefined {
  return CCTP_TESTNET_CHAINS.find(c => c.chainId === chainId);
}

// ABI fragments needed for CCTP operations
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export const TOKEN_MESSENGER_V2_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external",
];

export const MESSAGE_TRANSMITTER_V2_ABI = [
  "function receiveMessage(bytes message, bytes attestation) external",
];
