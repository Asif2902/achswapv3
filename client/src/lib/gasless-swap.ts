import { ethers, Contract, BrowserProvider, Interface, AbiCoder } from "ethers";
import { GASLESS_CONFIG, ERC20_ABI, CHAIN_ID, NATIVE_TOKEN } from "./gasless-config";

const abiCoder = new AbiCoder();
const ARC_TESTNET_WSS = "wss://arc-testnet.drpc.org";
const FAST_POLL_INTERVAL_MS = 400;

async function assertGaslessChain(signer: any): Promise<void> {
  const network = await signer.provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`Wrong network. Please switch to Arc Testnet.`);
  }
}

export function decodeExecutionError(data: string): string {
  if (!data || data === "0x") return "Unknown error";
  try {
    if (data.startsWith("0x") && data.length > 4) {
      const selector = data.slice(0, 10);
      if (selector === "0x08c379a0") {
        const iface = new Interface(["error Error(string)"]);
        const result = iface.decodeErrorResult("Error(string)", data);
        return result.args[0] as string;
      }
      if (selector === "0x3ee5aeb5") {
        const iface = new Interface(["error ExecutionFailed(bytes)"]);
        const result = iface.decodeErrorResult("ExecutionFailed(bytes)", data);
        return decodeExecutionError(result.args[0] as string);
      }
      return `Error selector: ${selector}`;
    }
  } catch (e) {
    console.error("Decode error:", e);
  }
  return data;
}

export async function fetchNonce(): Promise<bigint> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return BigInt("0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(""));
}

const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function permitTransferFrom((address,uint256,uint256,uint256),(address,uint256),address,bytes) external",
];

export async function checkPermit2Approval(
  signer: any,
  tokenIn: string
): Promise<boolean> {
  await assertGaslessChain(signer);
  const provider = signer.provider;
  const user = await signer.getAddress();
  const MAX_UINT160 = 2n ** 160n - 1n;
  
  const tokenContract = new Contract(tokenIn, ERC20_ABI, provider);
  const tokenAllowance = await tokenContract.allowance(user, GASLESS_CONFIG.permit2Address);
  
  if (tokenAllowance < MAX_UINT160 / 2n) {
    return false;
  }
  
  return true;
}

export async function approvePermit2(
  signer: any,
  tokenIn: string
): Promise<void> {
  await assertGaslessChain(signer);
  const user = await signer.getAddress();
  const MAX_UINT160 = 2n ** 160n - 1n;
  
  const tokenContract = new Contract(tokenIn, ERC20_ABI, signer);
  const tokenTx = await tokenContract.approve(GASLESS_CONFIG.permit2Address, MAX_UINT160);
  await tokenTx.wait();
  
  const permit2Contract = new Contract(GASLESS_CONFIG.permit2Address, PERMIT2_ABI, signer);
  const expiration = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const permitTx = await permit2Contract.approve(
    tokenIn,
    GASLESS_CONFIG.contractAddress,
    MAX_UINT160,
    expiration
  );
  
  await permitTx.wait();
}

export async function signPermit2(
  signer: any,
  tokenIn: string,
  amount: bigint,
  nonce: bigint,
  deadline: number
): Promise<string> {
  await assertGaslessChain(signer);
  const user = await signer.getAddress();
  
  const domain = {
    name: "Permit2",
    chainId: CHAIN_ID,
    verifyingContract: GASLESS_CONFIG.permit2Address,
  };
  
  const types = {
    PermitTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };
  
  const values = {
    permitted: {
      token: tokenIn,
      amount: amount,
    },
    spender: GASLESS_CONFIG.contractAddress,
    nonce: nonce,
    deadline: deadline,
  };
  
  const signature = await signer.signTypedData(domain, types, values);
  return signature;
}

export async function submitToRelayer(
  request: any
): Promise<{ txHash: string }> {
  const serializedRequest = JSON.stringify(request, (key, value) => 
    typeof value === "bigint" ? value.toString() : value
  );
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  
  try {
    const response = await fetch(GASLESS_CONFIG.relayerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializedRequest,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await response.text();
    if (!response.ok) {
      let errorMessage = `Relayer failed (${response.status})`;
      try {
        const error = JSON.parse(text);
        if (error.error) errorMessage = error.error;
      } catch {
        errorMessage = `Relayer error (${response.status}): ${text.slice(0, 200)}`;
      }
      throw new Error(errorMessage);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid relayer response: ${text.slice(0, 100)}`);
    }
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("Relayer request timed out");
    }
    throw err;
  }
}

export async function waitForTransaction(
  provider: any,
  txHash: string,
  timeout = 60000
): Promise<any> {
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const useArcWebSocket = chainId === 5042002;

  if (!useArcWebSocket) {
    const receipt = await provider.waitForTransaction(txHash, 1, timeout);
    if (!receipt) throw new Error("Transaction wait timeout");
    if (receipt.status === 0) throw new Error("Transaction reverted");
    return receipt;
  }

  const controller = new AbortController();
  let wsProvider: ethers.WebSocketProvider | null = new ethers.WebSocketProvider(ARC_TESTNET_WSS, chainId);

  const waitByPolling = async (signal: AbortSignal): Promise<any> => {
    const startTime = Date.now();
    while (!signal.aborted && Date.now() - startTime <= timeout) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        if (receipt.status === 0) throw new Error("Transaction reverted");
        return receipt;
      }

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, FAST_POLL_INTERVAL_MS);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(null);
          },
          { once: true },
        );
      });
    }

    if (signal.aborted) {
      throw new Error("Transaction wait aborted");
    }

    throw new Error("Transaction wait timeout");
  };

  const waitByWebSocket = async (signal: AbortSignal): Promise<any> => {
    if (!wsProvider) throw new Error("WebSocket provider unavailable");
    const handleAbort = () => {
      wsProvider?.destroy();
      wsProvider = null;
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    try {
      const receipt = await wsProvider.waitForTransaction(txHash, 1, timeout);
      if (!receipt) throw new Error("Transaction wait timeout");
      if (receipt.status === 0) throw new Error("Transaction reverted");
      return receipt;
    } finally {
      signal.removeEventListener("abort", handleAbort);
    }
  };

  try {
    const result = await Promise.race([
      waitByWebSocket(controller.signal),
      waitByPolling(controller.signal),
    ]);
    controller.abort();
    return result;
  } catch (error) {
    throw error;
  } finally {
    controller.abort();
    if (wsProvider) {
      wsProvider.destroy();
      wsProvider = null;
    }
  }
}

export async function executeGaslessSwapV2(
  signer: any,
  tokenIn: string,
  amountIn: bigint,
  amountOutMin: bigint,
  path: string[],
  deadline: number
): Promise<{ txHash: string; receipt: any }> {
  await assertGaslessChain(signer);
  const provider = signer.provider;
  const user = await signer.getAddress();
  
  const tokenForPermit2 = tokenIn;
  const nonce = await fetchNonce();
  
  const permitSig = await signPermit2(signer, tokenForPermit2, amountIn, nonce, deadline);
  
  const segment = {
    kind: 0,
    amountIn: amountIn,
    amountOutMin: amountOutMin,
    deadline: deadline,
    params: abiCoder.encode(["address[]"], [path]),
  };
  
  const request = {
    user: user,
    tokenIn: tokenIn,
    totalAmountIn: amountIn,
    permitNonce: nonce,
    permitDeadline: deadline,
    permitSig: permitSig,
    segment: segment,
  };
  
  const { txHash } = await submitToRelayer(request);
  
  const receipt = await waitForTransaction(provider, txHash);
  
  return { txHash, receipt };
}

export async function executeGaslessSwapV3(
  signer: any,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint,
  amountOutMin: bigint,
  deadline: number
): Promise<{ txHash: string; receipt: any }> {
  await assertGaslessChain(signer);
  const provider = signer.provider;
  const user = await signer.getAddress();
  
  const tokenForPermit2 = tokenIn;
  const nonce = await fetchNonce();
  
  const permitSig = await signPermit2(signer, tokenForPermit2, amountIn, nonce, deadline);
  
  const segment = {
    kind: 1,
    amountIn: amountIn,
    amountOutMin: amountOutMin,
    deadline: deadline,
    params: abiCoder.encode(["address", "uint24"], [tokenOut, fee]),
  };
  
  const request = {
    user: user,
    tokenIn: tokenIn,
    totalAmountIn: amountIn,
    permitNonce: nonce,
    permitDeadline: deadline,
    permitSig: permitSig,
    segment: segment,
  };
  
  const { txHash } = await submitToRelayer(request);
  
  const receipt = await waitForTransaction(provider, txHash);
  
  return { txHash, receipt };
}

function decodeV3Path(path: string): string {
  // If path is already a raw hex string (packed path), extract first token directly
  if (path.startsWith('0x')) {
    return '0x' + path.slice(2, 42);
  }
  // Otherwise, ABI-decode as bytes
  const decoded = abiCoder.decode(["bytes"], path)[0];
  return decoded.slice(0, 42);
}

export async function executeGaslessSwapV3MultiHop(
  signer: any,
  tokenIn: string,
  path: string,
  amountIn: bigint,
  amountOutMin: bigint,
  deadline: number
): Promise<{ txHash: string; receipt: any }> {
  await assertGaslessChain(signer);
  const provider = signer.provider;
  const user = await signer.getAddress();
  
  const pathFirstToken = decodeV3Path(path);
  if (pathFirstToken.toLowerCase() !== tokenIn.toLowerCase()) {
    throw new Error("Path first token does not match tokenIn");
  }
  
  const tokenForPermit2 = tokenIn;
  const nonce = await fetchNonce();
  
  const permitSig = await signPermit2(signer, tokenForPermit2, amountIn, nonce, deadline);
  
  const segment = {
    kind: 2,
    amountIn: amountIn,
    amountOutMin: amountOutMin,
    deadline: deadline,
    params: abiCoder.encode(["bytes"], [path]),
  };
  
  const request = {
    user: user,
    tokenIn: tokenIn,
    totalAmountIn: amountIn,
    permitNonce: nonce,
    permitDeadline: deadline,
    permitSig: permitSig,
    segment: segment,
  };
  
  const { txHash } = await submitToRelayer(request);
  
  const receipt = await waitForTransaction(provider, txHash);
  
  return { txHash, receipt };
}
