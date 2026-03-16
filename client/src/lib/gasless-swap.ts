import { ethers, Contract, BrowserProvider, Interface, AbiCoder } from "ethers";

const abiCoder = new AbiCoder();

async function assertGaslessChain(signer: any): Promise<void> {
  const network = await signer.provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`Wrong network. Please switch to Arc Testnet.`);
  }
}
import { GASLESS_CONFIG, ERC20_ABI, CHAIN_ID, NATIVE_TOKEN } from "./gasless-config";

export function decodeExecutionError(data: string): string {
  if (!data || data === "0x") return "Unknown error";
  try {
    if (data.startsWith("0x") && data.length > 4) {
      const selector = data.slice(0, 10);
      if (selector === "0x08c379a0") {
        const iface = new Interface(["function Error(string)"]);
        const result = iface.decodeErrorResult("Error(string)", data);
        return result.args[0] as string;
      }
      if (selector === "0x3ee5aeb5") {
        const iface = new Interface(["function ExecutionFailed(bytes)"]);
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

function getSwapDeadline(): number {
  return Math.floor(Date.now() / 1000) + 1800;
}

export async function fetchNonce(): Promise<bigint> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return BigInt("0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(""));
}

const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
  "function allowance(address user, address token, address spender) view returns (uint160)",
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
  
  const permit2Contract = new Contract(GASLESS_CONFIG.permit2Address, PERMIT2_ABI, provider);
  try {
    const allowance = await permit2Contract.allowance(user, tokenIn, GASLESS_CONFIG.contractAddress);
    if (allowance < MAX_UINT160 / 2n) {
      return false;
    }
  } catch {
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
  
  const permit2Contract = new Contract(GASLESS_CONFIG.permit2Address, PERMIT2_ABI, signer);
  const expiration = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const permitTx = await permit2Contract.approve(
    tokenIn,
    GASLESS_CONFIG.contractAddress,
    MAX_UINT160,
    expiration
  );
  
  await tokenTx.wait();
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
  
  const response = await fetch(GASLESS_CONFIG.relayerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: serializedRequest,
  });

  const text = await response.text();
  if (!response.ok) {
    try {
      const error = JSON.parse(text);
      throw new Error(error.error || `Relayer failed (${response.status})`);
    } catch {
      throw new Error(`Relayer error (${response.status}): ${text.slice(0, 200)}`);
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid relayer response: ${text.slice(0, 100)}`);
  }
}

export async function waitForTransaction(
  provider: any,
  txHash: string,
  timeout = 60000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const check = async () => {
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) {
          resolve(receipt);
          return;
        }
        if (Date.now() - startTime > timeout) {
          reject(new Error("Transaction wait timeout"));
          return;
        }
        setTimeout(check, 2000);
      } catch (e) {
        reject(e);
      }
    };
    
    check();
  });
}

export async function executeGaslessSwapV2(
  signer: any,
  tokenIn: string,
  amountIn: bigint,
  amountOutMin: bigint,
  path: string[]
): Promise<{ txHash: string; receipt: any }> {
  await assertGaslessChain(signer);
  const provider = signer.provider;
  const user = await signer.getAddress();
  
  const tokenForPermit2 = tokenIn;
  const nonce = await fetchNonce();
  const deadline = getSwapDeadline();
  
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
  amountOutMin: bigint
): Promise<{ txHash: string; receipt: any }> {
  await assertGaslessChain(signer);
  const provider = signer.provider;
  const user = await signer.getAddress();
  
  const tokenForPermit2 = tokenIn;
  const nonce = await fetchNonce();
  const deadline = getSwapDeadline();
  
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

export async function executeGaslessSwapV3MultiHop(
  signer: any,
  tokenIn: string,
  path: string,
  amountIn: bigint,
  amountOutMin: bigint
): Promise<{ txHash: string; receipt: any }> {
  await assertGaslessChain(signer);
  const provider = signer.provider;
  const user = await signer.getAddress();
  
  const tokenForPermit2 = tokenIn;
  const nonce = await fetchNonce();
  const deadline = getSwapDeadline();
  
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
