import { ethers } from "ethers";

const ABI = [
  "function execute((address,uint256,uint256,bytes),bytes) returns (bytes)",
  "function getNonce(address) view returns (uint256)"
];

const RPC_URL = "https://rpc.testnet.arc.network";
const CONTRACT_ADDRESS = "0x4bde23d3094334a9ebBc3733178ec1414F5332Bb";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, relayerWallet);

const ALLOWED_SELECTORS = [
  ethers.id("swapV2(uint256,uint256,address[],uint256)").slice(0, 10),
  ethers.id("swapV3(address,address,uint24,uint256,uint256,uint256)").slice(0, 10),
  ethers.id("swapV3MultiHop(bytes,uint256,uint256,uint256)").slice(0, 10),
  ethers.id("swapBatch((uint8,bytes)[])").slice(0, 10),
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const { request, signature } = req.body;

    if (!request || !signature) {
      return res.status(400).json({ error: "missing request or signature" });
    }

    const selector = request.data?.slice(0, 10);
    if (!ALLOWED_SELECTORS.includes(selector)) {
      return res.status(400).json({ error: "function not allowed" });
    }

    const onChainNonce = await contract.getNonce(request.from);
    if (BigInt(request.nonce) !== onChainNonce) {
      return res.status(400).json({ error: "invalid nonce" });
    }

    // Build the tuple properly for ethers
    const reqData = [
      request.from,
      request.nonce,
      request.gas,
      request.data
    ];

    const tx = await contract.execute(reqData, signature, {
      gasLimit: BigInt(request.gas) + 100000n,
    });

    res.json({ txHash: tx.hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
