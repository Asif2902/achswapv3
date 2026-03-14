import { JsonRpcProvider, Contract } from "ethers";

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function name() external view returns (string)",
  "function decimals() external view returns (uint8)"
];

async function run() {
  const provider = new JsonRpcProvider("https://rpc.testnet.arc.network");
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
      console.log(t, sym);
    } catch(e) {
      console.log(t, "FAILED to get symbol");
    }
  }
}
run();
