// AchTokenFactory + AchVerifiedRegistry — deployed on Arc Testnet
// Factory:  0x9Fc1dE24b1E9bB64E415b29aF12b7931F37F335D
// Registry: 0x29634D4Cdd8882AA36a24F4b20248975D812EB0C

export const FACTORY_ADDRESS = "0x9Fc1dE24b1E9bB64E415b29aF12b7931F37F335D";
export const REGISTRY_ADDRESS = "0x29634D4Cdd8882AA36a24F4b20248975D812EB0C";

export const ACH_TOKEN_FACTORY_ABI = [
  // ── Write ──
  "function deployToken(string _name, string _symbol, uint256 _totalSupply, string _logoUrl, uint256 _liquidityPercent) external payable",

  // ── Read — single token ──
  "function getToken(address tokenAddress) external view returns (tuple(address tokenAddress, address pairAddress, address owner, string name, string symbol, uint256 totalSupply, uint256 ownerTokens, string logoUrl, uint256 liquidityPercent, uint256 nativeAdded, uint256 createdAt))",
  "function getTokenLiquidity(address tokenAddress) external view returns (tuple(address pairAddress, uint256 tokenReserve, uint256 nativeReserve, bool hasEnoughLiquidity))",

  // ── Read — all tokens ──
  "function getAllTokens() external view returns (tuple(address tokenAddress, address pairAddress, address owner, string name, string symbol, uint256 totalSupply, uint256 ownerTokens, string logoUrl, uint256 liquidityPercent, uint256 nativeAdded, uint256 createdAt)[])",
  "function getAllTokensLiquidity() external view returns (tuple(address tokenAddress, address pairAddress, address owner, string name, string symbol, uint256 totalSupply, uint256 ownerTokens, string logoUrl, uint256 liquidityPercent, uint256 nativeAdded, uint256 createdAt)[], tuple(address pairAddress, uint256 tokenReserve, uint256 nativeReserve, bool hasEnoughLiquidity)[])",
  "function getTokensByOwner(address owner) external view returns (tuple(address tokenAddress, address pairAddress, address owner, string name, string symbol, uint256 totalSupply, uint256 ownerTokens, string logoUrl, uint256 liquidityPercent, uint256 nativeAdded, uint256 createdAt)[])",

  // ── Read — utils ──
  "function totalTokens() external view returns (uint256)",
  "function isFactoryToken(address tokenAddress) external view returns (bool)",
  "function COMMUNITY_THRESHOLD() external view returns (uint256)",

  // ── Events ──
  "event TokenCreated(address indexed tokenAddress, address indexed owner, string name, string symbol, uint256 totalSupply, address pairAddress, uint256 nativeAdded, uint256 liquidityPercent, string logoUrl, uint256 timestamp)",
];

export const ACH_VERIFIED_REGISTRY_ABI = [
  // ── Write (owner only) ──
  "function verify(address tokenAddress) external",
  "function unverify(address tokenAddress) external",
  "function verifyBatch(address[] calldata tokenAddresses) external",
  "function transferOwnership(address newOwner) external",

  // ── Read ──
  "function getAllVerified() external view returns (address[])",
  "function totalVerified() external view returns (uint256)",
  "function isVerified(address tokenAddress) external view returns (bool)",
  "function owner() external view returns (address)",
];
