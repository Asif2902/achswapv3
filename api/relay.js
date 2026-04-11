import { ethers } from "ethers";

const ABI = [
  "function execute(address user, address tokenIn, uint256 totalAmountIn, uint256 permitNonce, uint256 permitDeadline, bytes permitSig, (uint8 kind, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bytes params) segment)"
];

const CONTRACT_ADDRESS = "0x32a484dfFB67F4aABB14048248E1DC31F40FF957";
const RPC_URLS = [
  process.env.RELAYER_RPC_URL,
  "https://arc-testnet.drpc.org",
  "https://rpc.testnet.arc.network",
].filter((v, idx, arr) => typeof v === "string" && v.length > 0 && arr.indexOf(v) === idx);

const providers = RPC_URLS.map((url) => new ethers.JsonRpcProvider(url));
const providerReadyByIndex = new Map();

let relayerWallets = [];
let contracts = [];

if (process.env.RELAYER_PRIVATE_KEY) {
  relayerWallets = providers.map((provider) => new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider));
  contracts = relayerWallets.map((wallet) => new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet));
}

const nonceStateByWallet = new Map();
const nonceLockByWallet = new Map();

async function withNonceLock(walletAddress, task) {
  const key = walletAddress.toLowerCase();
  const previous = nonceLockByWallet.get(key) ?? Promise.resolve();

  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  const lock = previous.then(() => current);
  nonceLockByWallet.set(key, lock);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (nonceLockByWallet.get(key) === lock) {
      nonceLockByWallet.delete(key);
    }
  }
}

async function getNextNonce(provider, walletAddress) {
  return withNonceLock(walletAddress, async () => {
    const key = walletAddress.toLowerCase();
    const state = nonceStateByWallet.get(key) ?? { nextNonce: null };

    const pending = BigInt(await provider.getTransactionCount(walletAddress, "pending"));
    if (state.nextNonce === null || state.nextNonce < pending) {
      state.nextNonce = pending;
    }

    const nonce = state.nextNonce;
    state.nextNonce = nonce + 1n;
    nonceStateByWallet.set(key, state);
    return nonce;
  });
}

async function markNonceSuccess(walletAddress, nonce) {
  await withNonceLock(walletAddress, async () => {
    const key = walletAddress.toLowerCase();
    const state = nonceStateByWallet.get(key) ?? { nextNonce: null };
    const expectedNext = nonce + 1n;
    if (state.nextNonce === null || state.nextNonce < expectedNext) {
      state.nextNonce = expectedNext;
    }
    nonceStateByWallet.set(key, state);
  });
}

async function markNonceFailure(provider, walletAddress, nonce, err) {
  await withNonceLock(walletAddress, async () => {
    const key = walletAddress.toLowerCase();
    const state = nonceStateByWallet.get(key) ?? { nextNonce: null };
    const message = getErrorMessage(err);
    const retryable = isRetryableError(message);

    try {
      const pending = BigInt(await provider.getTransactionCount(walletAddress, "pending"));
      state.nextNonce = retryable ? (pending > nonce ? pending : nonce + 1n) : pending;
    } catch {
      state.nextNonce = retryable ? nonce + 1n : nonce;
    }

    nonceStateByWallet.set(key, state);
  });
}

function toBigInt(value, field) {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`invalid ${field}`);
  }
}

function getErrorMessage(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err.shortMessage) return String(err.shortMessage);
  if (err.message) return String(err.message);
  return JSON.stringify(err);
}

function isRetryableError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("nonce too low") ||
    text.includes("replacement transaction underpriced") ||
    text.includes("already known") ||
    text.includes("transaction underpriced") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("429") ||
    text.includes("rate") ||
    text.includes("network") ||
    text.includes("failed to detect network") ||
    text.includes("server error") ||
    text.includes("internal server error") ||
    text.includes("temporarily") ||
    text.includes("header not found")
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFeeOverrides(provider, attempt) {
  const feeData = await provider.getFeeData();
  const bumpPct = 140n + BigInt(attempt) * 20n;

  if (feeData.maxFeePerGas !== null || feeData.maxPriorityFeePerGas !== null) {
    const basePriority = feeData.maxPriorityFeePerGas ?? 1_500_000_000n;
    const baseMax = feeData.maxFeePerGas ?? (feeData.gasPrice !== null ? feeData.gasPrice * 2n : basePriority * 2n);
    const maxPriorityFeePerGas = (basePriority * bumpPct) / 100n + 1n;
    const bumpedMax = (baseMax * bumpPct) / 100n + 1n;
    const minMax = maxPriorityFeePerGas * 2n;
    const maxFeePerGas = bumpedMax > minMax ? bumpedMax : minMax;
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  if (feeData.gasPrice !== null) {
    return { gasPrice: (feeData.gasPrice * bumpPct) / 100n + 1n };
  }

  return {};
}

async function ensureProviderReady(provider, idx) {
  if (providerReadyByIndex.get(idx)) return;
  await provider.getNetwork();
  providerReadyByIndex.set(idx, true);
}

async function sendExecuteWithRetry(payload) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const idx = attempt % contracts.length;
    const contract = contracts[idx];
    const wallet = relayerWallets[idx];
    const provider = providers[idx];
    let nonce = null;

    try {
      await ensureProviderReady(provider, idx);
      const feeOverrides = await getFeeOverrides(provider, attempt);
      nonce = await getNextNonce(provider, wallet.address);

      const txRequest = await contract.execute.populateTransaction(
        payload.user,
        payload.tokenIn,
        payload.totalAmountIn,
        payload.permitNonce,
        payload.permitDeadline,
        payload.permitSig,
        payload.segment,
      );

      let gasLimit;
      try {
        const estimatedGas = await provider.estimateGas({
          ...txRequest,
          from: wallet.address,
        });
        gasLimit = (estimatedGas * 130n) / 100n + 25_000n;
      } catch {
        gasLimit = 2_400_000n;
      }

      const tx = await contract.execute(
        payload.user,
        payload.tokenIn,
        payload.totalAmountIn,
        payload.permitNonce,
        payload.permitDeadline,
        payload.permitSig,
        payload.segment,
        {
          ...feeOverrides,
          gasLimit,
          nonce,
        },
      );

      await markNonceSuccess(wallet.address, nonce);

      return tx;
    } catch (err) {
      lastError = err;
      if (nonce !== null) {
        await markNonceFailure(provider, wallet.address, nonce, err);
      }
      const message = getErrorMessage(err);
      if (!isRetryableError(message) || attempt === 4) {
        break;
      }
      await sleep(150 * (attempt + 1));
    }
  }

  throw lastError;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  if (contracts.length === 0) {
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

    const tx = await sendExecuteWithRetry({
      user,
      tokenIn,
      totalAmountIn: toBigInt(totalAmountIn, "totalAmountIn"),
      permitNonce: toBigInt(permitNonce, "permitNonce"),
      permitDeadline: toBigInt(permitDeadline, "permitDeadline"),
      permitSig,
      segment: {
        kind: toBigInt(segment.kind, "segment.kind"),
        amountIn: toBigInt(segment.amountIn, "segment.amountIn"),
        amountOutMin: toBigInt(segment.amountOutMin, "segment.amountOutMin"),
        deadline: toBigInt(segment.deadline, "segment.deadline"),
        params: segment.params,
      },
    });

    res.json({ txHash: tx.hash, rpc: providers.length });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
}
