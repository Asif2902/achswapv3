const { JsonRpcProvider, Contract } = require("ethers");

const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() external view returns (uint256)",
];

const FACTORY_ABI = [
  "function allPairsLength() external view returns (uint)",
  "function allPairs(uint) external view returns (address)",
];

const ERC20_ABI = [
    "function symbol() external view returns (string)",
    "function name() external view returns (string)",
    "function decimals() external view returns (uint8)"
];

async function run() {
  const provider = new JsonRpcProvider("https://rpc.testnet.arc.network");
  const factory = new Contract("0x7cC023C7184810B84657D55c1943eBfF8603B72B", FACTORY_ABI, provider);
  
  const len = await factory.allPairsLength();
  console.log("V2 lengths:", len.toString());
  
  const pools = [];
  for(let i=0; i<Math.min(Number(len), 100); i++) {
     const addr = await factory.allPairs(i);
     const pair = new Contract(addr, PAIR_ABI, provider);
     try {
         const t0 = await pair.token0();
         const t1 = await pair.token1();
         
         const t0c = new Contract(t0, ERC20_ABI, provider);
         const t1c = new Contract(t1, ERC20_ABI, provider);
         
         const sym0 = await t0c.symbol().catch(() => "FAIL");
         const sym1 = await t1c.symbol().catch(() => "FAIL");
         
         pools.push({ addr, t0, sym0, t1, sym1 });
         console.log(i, "Pair", addr, sym0, sym1);
     } catch(e) {
         console.error("Pair error",i, addr, e.message);
     }
  }
}
run();
