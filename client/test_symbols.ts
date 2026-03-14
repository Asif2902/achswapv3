import { JsonRpcProvider, Contract } from "ethers";

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function name() external view returns (string)",
  "function decimals() external view returns (uint8)"
];
const ERC20_BYTES32_ABI = [
  "function symbol() external view returns (bytes32)",
  "function name() external view returns (bytes32)"
];

async function run() {
  const provider = new JsonRpcProvider("https://rpc.testnet.arc.network");
  const addrs = [
    "0xACeC008D9346618d7955F1069811C49F3f3d7907", // act token factory... wait no, need actual token
    "0x12E7bDD01Aa7F463eB75bDEb7c07883d45704978" // APD wUSDC pair
  ];
  // wait we need to test some actual token addresses that were discovered.
  // let's just query a known v3 pool tokens
  const factory = new Contract("0x65fa500712D451b521bA114a4D3962565969F06a", [
    "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
  ], provider);
  
  const url = `https://testnet.arcscan.app/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=0x65fa500712D451b521bA114a4D3962565969F06a`;
  const res = await fetch(url);
  const data = await res.json();
  const tokens = new Set<string>();
  
  if (data && data.result) {
    for (const log of data.result) {
      try {
        const parsed = factory.interface.parseLog({
          topics: log.topics.filter((t: any) => t !== null),
          data: log.data
        });
        if (parsed && parsed.name === "PoolCreated") {
          tokens.add(parsed.args[0]);
          tokens.add(parsed.args[1]);
        }
      } catch(e) {}
    }
  }

  console.log(`Checking ${tokens.size} tokens...`);
  for (const t of Array.from(tokens)) {
    const c = new Contract(t, ERC20_ABI, provider);
    try {
      const sym = await c.symbol();
      if (!sym) console.log(t, "Empty string symbol");
    } catch(e) {
      console.log(t, "String symbol failed. Trying bytes32...");
      try {
        const c32 = new Contract(t, ERC20_BYTES32_ABI, provider);
        const sym32 = await c32.symbol();
        console.log(t, "Bytes32:", sym32);
      } catch(e2) {
        console.log(t, "Bytes32 also failed.");
      }
    }
  }
}
run();
