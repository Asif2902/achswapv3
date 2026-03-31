// RWA Vault & Registry ABIs

export const RWA_VAULT_ABI = [
  // Core swap functions
  "function buy(uint256 pairId, uint256 minSynth) external payable",
  "function redeem(uint256 pairId, uint256 synthAmount, uint256 minUsdc) external",
  // Quote functions
  "function quoteBuy(uint256 pairId, uint256 usdcIn) external view returns (uint256 synthOut, uint256 fee, uint256 netUsdc, uint256 price, bool isStale)",
  "function quoteRedeem(uint256 pairId, uint256 synthAmount) external view returns (uint256 usdcOut, uint256 fee, uint256 grossUsdc, uint256 price, bool isStale)",
  // View functions
  "function FEE_BPS() external view returns (uint256)",
  "function BPS_DENOMINATOR() external view returns (uint256)",
  "function totalReserve() external view returns (uint256)",
  "function getVaultBalance() external view returns (uint256 rawBalance, uint256 reserve, uint256 fees, uint256 totalBuys, uint256 totalRedeems, uint256 totalFeesEarned)",
];

export const RWA_REGISTRY_ABI = [
  "function getPair(uint256 pairId) external view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, bool active, uint256 createdAt))",
  "function getPrice(uint256 pairId) external view returns (uint256 price, uint256 lastUpdated, uint256 age, bool isStale)",
  "function getAllPairs() external view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, bool active, uint256 createdAt)[])",
  "function pairCount() external view returns (uint256)",
];

export const RWASynth_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
