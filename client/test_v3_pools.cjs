const { JsonRpcProvider, Contract } = require("ethers");
const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];

async function run() {
  const provider = new JsonRpcProvider("https://rpc.testnet.arc.network");
  const factory = new Contract("0x65fa500712D451b521bA114a4D3962565969F06a", V3_FACTORY_ABI, provider);
  
  console.log("Fetching PoolCreated events...");
  try {
    const filter = factory.filters.PoolCreated();
    const events = await factory.queryFilter(filter, 0, "latest");
    console.log("Events found:", events.length);
  } catch (e) {
    console.error("Event fetch failed:", e.message);
  }
}
run();
