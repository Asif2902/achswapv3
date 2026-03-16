import { ethers } from "ethers";

const RPC_URL = "https://rpc.testnet.arc.network";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const permit2Contract = new ethers.Contract(
  PERMIT2_ADDRESS,
  ["function nonce(address user, address token) view returns (uint256)"],
  provider
);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  const { address, token } = req.query;
  if (!address) return res.status(400).json({ error: "missing address" });

  const tokenAddress = token || "0x3600000000000000000000000000000000000000";

  try {
    const nonce = await permit2Contract.nonce(address, tokenAddress);
    res.json({ nonce: nonce.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
