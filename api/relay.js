import { ethers } from "ethers";

const ABI = [
  "function execute(address user, address tokenIn, uint256 totalAmountIn, uint256 permitNonce, uint256 permitDeadline, bytes permitSig, (uint8 kind, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bytes params) segment)"
];

const RPC_URL = "https://rpc.testnet.arc.network";
const CONTRACT_ADDRESS = "0x28021558B4f60d90A97bE77D9462f06EAf92A1b9";

const provider = new ethers.JsonRpcProvider(RPC_URL);

let relayerWallet = null;
let contract = null;

if (process.env.RELAYER_PRIVATE_KEY) {
  relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
  contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, relayerWallet);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  if (!relayerWallet || !contract) {
    return res.status(503).json({ error: "relayer not configured" });
  }

  try {
    const { user, tokenIn, totalAmountIn, permitNonce, permitDeadline, permitSig, segment } = req.body;

    if (!user || !tokenIn || totalAmountIn == null || permitNonce == null || permitDeadline == null || !permitSig || !segment) {
      return res.status(400).json({ error: "missing required parameters" });
    }

    // Validate segment
    if (segment.kind == null || segment.amountIn == null || segment.amountOutMin == null || segment.deadline == null || !segment.params) {
      return res.status(400).json({ error: "invalid segment" });
    }

    // Validate kind is 0, 1, or 2
    const validKinds = [0, 1, 2];
    if (!validKinds.includes(Number(segment.kind))) {
      return res.status(400).json({ error: "invalid segment kind" });
    }

    // Validate addresses
    if (!ethers.isAddress(user) || !ethers.isAddress(tokenIn)) {
      return res.status(400).json({ error: "invalid address" });
    }

    const tx = await contract.execute(
      user,
      tokenIn,
      BigInt(totalAmountIn),
      BigInt(permitNonce),
      BigInt(permitDeadline),
      permitSig,
      {
        kind: BigInt(segment.kind),
        amountIn: BigInt(segment.amountIn),
        amountOutMin: BigInt(segment.amountOutMin),
        deadline: BigInt(segment.deadline),
        params: segment.params
      },
      {
        gasLimit: 2000000n,
        maxFeePerGas: 500000000000n, // 500 gwei
        maxPriorityFeePerGas: 50000000000n, // 50 gwei
      }
    );

    res.json({ txHash: tx.hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
