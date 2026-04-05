// RWA Vault & Oracle ABIs (AchRWA Protocol v2)

export const RWA_VAULT_ABI = [
  // Core swap functions
  "function buy(uint256 pairId, uint256 minSynth) external payable",
  "function redeem(uint256 pairId, uint256 synthAmount, uint256 minUsdc) external",
  // Quote functions
  "function quoteBuy(uint256 pairId, uint256 usdcIn) external view returns (uint256 synthOut, uint256 fee, uint256 netUsdc, uint256 price, bool isStale)",
  "function quoteRedeem(uint256 pairId, uint256 synthAmount) external view returns (uint256 usdcOut, uint256 fee, uint256 grossUsdc, uint256 price, bool isStale, bool reserveOk)",
  // View functions
  "function FEE_BPS() external view returns (uint256)",
  "function BPS_DENOMINATOR() external view returns (uint256)",
  "function MAX_TX_AMOUNT() external view returns (uint256)",
  "function totalReserve() external view returns (uint256)",
  "function paused() external view returns (bool)",
  "function oracle() external view returns (address)",
  "function getVaultBalance() external view returns (uint256 rawBalance, uint256 reserve, uint256 fees, uint256 totalBuys, uint256 totalRedeems, uint256 totalFeesEarned, uint256 totalVolumeUSDC)",
  "function reserveRatio() external view returns (uint256 ratio, uint256 totalReserve, uint256 totalSynthValue, bool isHealthy)",
  "function getUserPortfolio(address user) external view returns (uint256[] pairIds, string[] symbols, uint256[] synthBalances, uint256[] usdValues, uint256[] prices, bool[] staleFlags)",
];

export const RWA_ORACLE_ABI = [
  "function getPair(uint256 pairId) external view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, uint256 maxDeviation, bool active, bool frozen, uint256 createdAt))",
  "function getPrice(uint256 pairId) external view returns (uint256 price, uint256 lastUpdated, uint256 age, bool isStale)",
  "function getAllPairs() external view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, uint256 maxDeviation, bool active, bool frozen, uint256 createdAt)[])",
  "function pairCount() external view returns (uint256)",
  "function canUsePrice(uint256 pairId) external view returns (bool usable, uint256 price, string reason)",
  "function paused() external view returns (bool)",
];

export const RWASynth_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function balanceOf(address) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
];

// Keep old name as alias for backwards compat
export const RWA_REGISTRY_ABI = RWA_ORACLE_ABI;
