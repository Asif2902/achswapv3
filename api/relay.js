import { ethers } from "ethers";

const ABI = [
  "function execute(address user, address tokenIn, uint256 totalAmountIn, uint256 permitNonce, uint256 permitDeadline, bytes permitSig, (uint8 kind, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bytes params) segment)"
];

const RPC_URL = "https://rpc.testnet.arc.network";
const CONTRACT_ADDRESS = "0x64f7e5Dc74194C48c79BE20303996d15Cbe2868d";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, relayerWallet);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const { user, tokenIn, totalAmountIn, permitNonce, permitDeadline, permitSig, segment } = req.body;

    if (!user || !tokenIn || !totalAmountIn || !permitNonce || !permitDeadline || !permitSig || !segment) {
      return res.status(400).json({ error: "missing required parameters" });
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
        gasLimit: 800000n,
      }
    );

    res.json({ txHash: tx.hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
