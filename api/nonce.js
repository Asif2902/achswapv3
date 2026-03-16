import { ethers } from "ethers";

const RPC_URL = "https://rpc.testnet.arc.network";
const CONTRACT_ADDRESS = "0x8E8E5f34405B300E77a0DEbb179CbBD2Fdf91016";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  ["function getNonce(address) view returns (uint256)"],
  provider
);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "missing address" });

  try {
    const nonce = await contract.getNonce(address);
    res.json({ nonce: nonce.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
