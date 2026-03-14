import { JsonRpcProvider, Contract } from "ethers";

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function name() external view returns (string)",
  "function decimals() external view returns (uint8)"
];
const FACTORY_V2 = "0x7cC023C7184810B84657D55c1943eBfF8603B72B";

const FACTORY_ABI_V2 = [
  "function allPairsLength() external view returns (uint)",
  "function allPairs(uint) external view returns (address)",
];
const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

async function run() {
  const provider = new JsonRpcProvider("https://rpc.testnet.arc.network");
  const factory = new Contract(FACTORY_V2, FACTORY_ABI_V2, provider);
  const len = await factory.allPairsLength();
  
  const tokens = new Set<string>();
  
  console.log("Checking V2 tokens...");
  for(let i=0; i<Math.min(Number(len), 100); i++) {
     try {
       const addr = await factory.allPairs(i);
       const pair = new Contract(addr, PAIR_ABI, provider);
       const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
       tokens.add(t0); tokens.add(t1);
     } catch(e) {}
  }
  
  for (const t of Array.from(tokens)) {
    const c = new Contract(t, ERC20_ABI, provider);
    try {
      const sym = await c.symbol();
      if (!sym || sym.trim() === "") console.log(t, "Empty string");
    } catch(e) {
      console.log(t, "FAILED to read string. Might be bytes32 or invalid.");
    }
  }
}
run();
