import { ethers, Contract, BrowserProvider } from "ethers";
import { GASLESS_CONFIG, GASLESS_ABI, ERC20_ABI, CHAIN_ID } from "./gasless-config";

function generateRandomNonce(): bigint {
  return BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}

function getPermitDeadline(): number {
  return Math.floor(Date.now() / 1000) + 3600; // 1 hour
}

function getSwapDeadline(): number {
  return Math.floor(Date.now() / 1000) + 1800; // 30 minutes
}

export async function signPermit2(
  signer: any,
  tokenIn: string,
  amountIn: bigint
): Promise<{ nonce: bigint; deadline: number; signature: string }> {
  const nonce = generateRandomNonce();
  const deadline = getPermitDeadline();

  const permitSig = await signer.signTypedData(
    {
      name: "Permit2",
      chainId: CHAIN_ID,
      verifyingContract: GASLESS_CONFIG.permit2Address,
    },
    {
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
    },
    {
      permitted: { token: tokenIn, amount: amountIn },
      spender: GASLESS_CONFIG.contractAddress,
      nonce: nonce,
      deadline: deadline,
    }
  );

  return { nonce, deadline, signature: permitSig };
}

export async function fetchNonce(userAddress: string): Promise<number> {
  const url = `${GASLESS_CONFIG.nonceUrl}?address=${userAddress}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Nonce API error (${response.status}): ${text.slice(0, 100)}`);
  }
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return parseInt(data.nonce, 10);
  } catch {
    throw new Error(`Invalid nonce response: ${text.slice(0, 100)}`);
  }
}

export async function checkAndApprovePermit2(
  signer: any,
  tokenIn: string
): Promise<boolean> {
  const provider = signer.provider;
  const user = await signer.getAddress();
  const tokenContract = new Contract(tokenIn, ERC20_ABI, provider);
  
  const permit2 = GASLESS_CONFIG.permit2Address;
  const allowance = await tokenContract.allowance(user, permit2);
  
  if (allowance === 0n) {
    return false; // Needs approval
  }
  return true; // Already approved
}

export async function approveTokenForPermit2(
  signer: any,
  tokenIn: string
): Promise<string> {
  const tokenContract = new Contract(tokenIn, ERC20_ABI, signer);
  const tx = await tokenContract.approve(
    GASLESS_CONFIG.permit2Address,
    ethers.MaxUint256
  );
  return tx.hash;
}

export async function signForwardRequest(
  signer: any,
  request: {
    from: string;
    nonce: number;
    gas: number;
    data: string;
  }
): Promise<string> {
  const signature = await signer.signTypedData(
    {
      name: "AchSwapGasless",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: GASLESS_CONFIG.contractAddress,
    },
    {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
    },
    request
  );

  return signature;
}

export async function submitToRelayer(
  request: {
    from: string;
    nonce: number;
    gas: number;
    data: string;
  },
  signature: string
): Promise<{ txHash: string }> {
  const response = await fetch(GASLESS_CONFIG.relayerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request, signature }),
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
  provider: BrowserProvider,
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
  path: string[],
  isPermit2Approved: boolean
): Promise<{ txHash: string; receipt: any }> {
  const provider = signer.provider;
  const user = await signer.getAddress();
  const iface = new ethers.Interface(GASLESS_ABI);

  if (!isPermit2Approved) {
    throw new Error("Token not approved for Permit2. Please approve first.");
  }

  const { nonce: permitNonce, deadline: permitDeadline, signature: permitSig } =
    await signPermit2(signer, tokenIn, amountIn);

  const swapDeadline = getSwapDeadline();

  const swapCalldata = iface.encodeFunctionData("swapV2", [
    amountIn,
    amountOutMin,
    path,
    swapDeadline,
    permitNonce,
    permitDeadline,
    permitSig,
  ]);

  const nonce = await fetchNonce(user);

  const request = {
    from: user,
    nonce: nonce,
    gas: 500000,
    data: swapCalldata,
  };

  const forwarderSig = await signForwardRequest(signer, request);

  const { txHash } = await submitToRelayer(request, forwarderSig);

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
  isPermit2Approved: boolean
): Promise<{ txHash: string; receipt: any }> {
  const provider = signer.provider;
  const user = await signer.getAddress();
  const iface = new ethers.Interface(GASLESS_ABI);

  if (!isPermit2Approved) {
    throw new Error("Token not approved for Permit2. Please approve first.");
  }

  const { nonce: permitNonce, deadline: permitDeadline, signature: permitSig } =
    await signPermit2(signer, tokenIn, amountIn);

  const swapDeadline = getSwapDeadline();

  const swapCalldata = iface.encodeFunctionData("swapV3", [
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    amountOutMin,
    swapDeadline,
    permitNonce,
    permitDeadline,
    permitSig,
  ]);

  const nonce = await fetchNonce(user);

  const request = {
    from: user,
    nonce: nonce,
    gas: 500000,
    data: swapCalldata,
  };

  const forwarderSig = await signForwardRequest(signer, request);

  const { txHash } = await submitToRelayer(request, forwarderSig);

  const receipt = await waitForTransaction(provider, txHash);

  return { txHash, receipt };
}

export async function executeGaslessSwapV3MultiHop(
  signer: any,
  path: string,
  amountIn: bigint,
  amountOutMin: bigint,
  isPermit2Approved: boolean
): Promise<{ txHash: string; receipt: any }> {
  const provider = signer.provider;
  const user = await signer.getAddress();
  const iface = new ethers.Interface(GASLESS_ABI);

  if (!isPermit2Approved) {
    throw new Error("Token not approved for Permit2. Please approve first.");
  }

  const { nonce: permitNonce, deadline: permitDeadline, signature: permitSig } =
    await signPermit2(signer, path.slice(0, 42), amountIn);

  const swapDeadline = getSwapDeadline();

  const swapCalldata = iface.encodeFunctionData("swapV3MultiHop", [
    path,
    amountIn,
    amountOutMin,
    swapDeadline,
    permitNonce,
    permitDeadline,
    permitSig,
  ]);

  const nonce = await fetchNonce(user);

  const request = {
    from: user,
    nonce: nonce,
    gas: 500000,
    data: swapCalldata,
  };

  const forwarderSig = await signForwardRequest(signer, request);

  const { txHash } = await submitToRelayer(request, forwarderSig);

  const receipt = await waitForTransaction(provider, txHash);

  return { txHash, receipt };
}
