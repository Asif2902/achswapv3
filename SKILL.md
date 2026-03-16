# AchSwapGasless — Complete Implementation Reference

This document is a full reference for any AI agent tasked with implementing, extending,
or debugging any part of the AchSwapGasless system. Read this entirely before writing
any code.

---

## 1. System Overview

AchSwapGasless is a single deployed contract that enables **fully gasless token swaps**
on Arc Testnet. Users sign typed messages off-chain. A relayer backend (hosted on Vercel)
submits the actual on-chain transaction and pays gas.

Three components:
1. **Smart contract** — live on Arc Testnet
2. **Vercel serverless API** — relayer backend
3. **Frontend** — React/JS, calls Vercel API instead of chain directly

Token approval flow uses **Permit2** (no `approve()` tx needed after one-time setup).
Meta-transaction flow uses a **built-in EIP-2771 forwarder** (no separate forwarder contract).

---

## 2. Deployed Addresses

| Contract           | Address                                      | Network      |
|--------------------|----------------------------------------------|--------------|
| AchSwapGasless     | `0x8E8E5f34405B300E77a0DEbb179CbBD2Fdf91016` | Arc Testnet  |
| Permit2 (canonical)| `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Arc Testnet  |

Owner (deployer): set at deploy — can pause, unpause, rescueTokens only.
Relayer: separate hot wallet on Vercel — calls execute() / executeBatch().

---

## 3. Contract ABI

### Full ABI (JSON)

```json
[
  {
    "type": "constructor",
    "inputs": [
      { "name": "_v2Router", "type": "address" },
      { "name": "_v3Router", "type": "address" }
    ]
  },
  {
    "type": "function",
    "name": "getNonce",
    "stateMutability": "view",
    "inputs": [{ "name": "from", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "type": "function",
    "name": "execute",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "req",
        "type": "tuple",
        "components": [
          { "name": "from",  "type": "address" },
          { "name": "nonce", "type": "uint256" },
          { "name": "gas",   "type": "uint256" },
          { "name": "data",  "type": "bytes"   }
        ]
      },
      { "name": "signature", "type": "bytes" }
    ],
    "outputs": [{ "name": "returndata", "type": "bytes" }]
  },
  {
    "type": "function",
    "name": "executeBatch",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "reqs",
        "type": "tuple[]",
        "components": [
          { "name": "from",  "type": "address" },
          { "name": "nonce", "type": "uint256" },
          { "name": "gas",   "type": "uint256" },
          { "name": "data",  "type": "bytes"   }
        ]
      },
      { "name": "signatures",         "type": "bytes[]" },
      { "name": "continueOnFailure",  "type": "bool"    }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "swapV2",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "amountIn",       "type": "uint256"    },
      { "name": "amountOutMin",   "type": "uint256"    },
      { "name": "path",           "type": "address[]"  },
      { "name": "deadline",       "type": "uint256"    },
      { "name": "permitNonce",    "type": "uint256"    },
      { "name": "permitDeadline", "type": "uint256"    },
      { "name": "permitSig",      "type": "bytes"      }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "swapV3",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "tokenIn",        "type": "address" },
      { "name": "tokenOut",       "type": "address" },
      { "name": "fee",            "type": "uint24"  },
      { "name": "amountIn",       "type": "uint256" },
      { "name": "amountOutMin",   "type": "uint256" },
      { "name": "deadline",       "type": "uint256" },
      { "name": "permitNonce",    "type": "uint256" },
      { "name": "permitDeadline", "type": "uint256" },
      { "name": "permitSig",      "type": "bytes"   }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "swapV3MultiHop",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "path",           "type": "bytes"   },
      { "name": "amountIn",       "type": "uint256" },
      { "name": "amountOutMin",   "type": "uint256" },
      { "name": "deadline",       "type": "uint256" },
      { "name": "permitNonce",    "type": "uint256" },
      { "name": "permitDeadline", "type": "uint256" },
      { "name": "permitSig",      "type": "bytes"   }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "swapBatch",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "calls",
        "type": "tuple[]",
        "components": [
          { "name": "kind", "type": "uint8" },
          { "name": "data", "type": "bytes" }
        ]
      }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "pause",
    "stateMutability": "nonpayable",
    "inputs": [],
    "outputs": []
  },
  {
    "type": "function",
    "name": "unpause",
    "stateMutability": "nonpayable",
    "inputs": [],
    "outputs": []
  },
  {
    "type": "function",
    "name": "rescueTokens",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "token",  "type": "address" },
      { "name": "amount", "type": "uint256" }
    ],
    "outputs": []
  },
  {
    "type": "event",
    "name": "SwapV2Executed",
    "inputs": [
      { "name": "user",      "type": "address", "indexed": true },
      { "name": "tokenIn",   "type": "address", "indexed": true },
      { "name": "tokenOut",  "type": "address", "indexed": true },
      { "name": "amountIn",  "type": "uint256", "indexed": false },
      { "name": "amountOut", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "SwapV3Executed",
    "inputs": [
      { "name": "user",      "type": "address", "indexed": true },
      { "name": "tokenIn",   "type": "address", "indexed": true },
      { "name": "tokenOut",  "type": "address", "indexed": true },
      { "name": "amountIn",  "type": "uint256", "indexed": false },
      { "name": "amountOut", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "MetaTxExecuted",
    "inputs": [
      { "name": "from",  "type": "address", "indexed": true },
      { "name": "nonce", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "BatchResult",
    "inputs": [
      { "name": "index",   "type": "uint256", "indexed": true  },
      { "name": "from",    "type": "address", "indexed": true  },
      { "name": "success", "type": "bool",    "indexed": false },
      { "name": "reason",  "type": "bytes",   "indexed": false }
    ]
  }
]
```

### Function Selectors

| Function        | Selector     |
|-----------------|--------------|
| swapV2          | `0x`+ `ethers.id("swapV2(uint256,uint256,address[],uint256,uint256,uint256,bytes)").slice(0,10)` |
| swapV3          | `0x`+ `ethers.id("swapV3(address,address,uint24,uint256,uint256,uint256,uint256,uint256,bytes)").slice(0,10)` |
| swapV3MultiHop  | `0x`+ `ethers.id("swapV3MultiHop(bytes,uint256,uint256,uint256,uint256,uint256,bytes)").slice(0,10)` |
| swapBatch       | `0x`+ `ethers.id("swapBatch((uint8,bytes)[])").slice(0,10)` |

Always compute selectors at runtime using ethers.id() — never hardcode them.

---

## 4. SwapKind Enum

Used in swapBatch calls:

```
0 = V2
1 = V3Single
2 = V3Multi
```

---

## 5. EIP-712 Domain

This is the domain used when signing ForwardRequests. Must match exactly or signatures will fail.

```js
const domain = {
  name: "AchSwapGasless",
  version: "1",
  chainId: <Arc Testnet chainId>,
  verifyingContract: "0x8E8E5f34405B300E77a0DEbb179CbBD2Fdf91016",
};
```

ForwardRequest type:

```js
const types = {
  ForwardRequest: [
    { name: "from",  type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "gas",   type: "uint256" },
    { name: "data",  type: "bytes"   },
  ],
};
```

Note: `to` and `value` are NOT in the struct. `to` is always the contract itself.
`value` is always 0. Removing them reduces attack surface.

---

## 6. Permit2 Signing

Permit2 address: `0x000000000022D473030F116dDEE9F6B43aC78BA3`

### One-time setup per token per user (only on-chain tx the user ever pays)

```js
const token = new ethers.Contract(TOKEN_ADDRESS, [
  "function approve(address spender, uint256 amount) returns (bool)"
], signer);
await token.approve("0x000000000022D473030F116dDEE9F6B43aC78BA3", ethers.MaxUint256);
```

### Permit2 signature

```js
const permitNonce = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)); // random uint256
const permitDeadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

const permit2Domain = {
  name: "Permit2",
  chainId: <chainId>,
  verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

const permitTypes = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender",   type: "address"          },
    { name: "nonce",     type: "uint256"           },
    { name: "deadline",  type: "uint256"           },
  ],
  TokenPermissions: [
    { name: "token",  "type": "address" },
    { name: "amount", "type": "uint256" },
  ],
};

const permitValue = {
  permitted: { token: TOKEN_ADDRESS, amount: amountIn },
  spender:   "0x8E8E5f34405B300E77a0DEbb179CbBD2Fdf91016", // AchSwapGasless
  nonce:     permitNonce,
  deadline:  permitDeadline,
};

const permitSig = await signer.signTypedData(permit2Domain, permitTypes, permitValue);
```

CRITICAL: Permit2 uses unordered nonces (bitmap-based). Always use a random uint256.
Never use sequential nonces for Permit2. The contract will reject replays automatically.

---

## 7. Frontend — Complete Flow

### gaslessSwapV2

```js
import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0x8E8E5f34405B300E77a0DEbb179CbBD2Fdf91016";
const PERMIT2_ADDRESS  = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const RELAYER_URL      = "https://your-project.vercel.app/api/relay";

async function gaslessSwapV2({ signer, tokenIn, amountIn, path, amountOutMin }) {
  const provider = signer.provider;
  const user     = await signer.getAddress();
  const network  = await provider.getNetwork();
  const chainId  = network.chainId;

  // 1. Permit2 signature
  const permitNonce    = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const permitDeadline = Math.floor(Date.now() / 1000) + 3600;
  const swapDeadline   = Math.floor(Date.now() / 1000) + 1800;

  const permitSig = await signer.signTypedData(
    { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
    {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender",   type: "address"          },
        { name: "nonce",     type: "uint256"           },
        { name: "deadline",  type: "uint256"           },
      ],
      TokenPermissions: [
        { name: "token",  type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    {
      permitted: { token: tokenIn, amount: amountIn },
      spender:   CONTRACT_ADDRESS,
      nonce:     permitNonce,
      deadline:  permitDeadline,
    }
  );

  // 2. Encode swap calldata
  const iface       = new ethers.Interface(ABI); // use full ABI from section 3
  const swapCalldata = iface.encodeFunctionData("swapV2", [
    amountIn,
    amountOutMin,
    path,
    swapDeadline,
    permitNonce,
    permitDeadline,
    permitSig,
  ]);

  // 3. Fetch nonce from relayer (avoids extra RPC call)
  const { nonce } = await fetch(`${RELAYER_URL.replace("relay","nonce")}?address=${user}`)
    .then(r => r.json());

  // 4. Build ForwardRequest
  const request = {
    from:  user,
    nonce: nonce,
    gas:   350000,
    data:  swapCalldata,
  };

  // 5. Sign ForwardRequest
  const forwarderSig = await signer.signTypedData(
    {
      name:              "AchSwapGasless",
      version:           "1",
      chainId,
      verifyingContract: CONTRACT_ADDRESS,
    },
    {
      ForwardRequest: [
        { name: "from",  type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "gas",   type: "uint256" },
        { name: "data",  type: "bytes"   },
      ],
    },
    request
  );

  // 6. Send to relayer — do NOT await confirmation here
  const res = await fetch(RELAYER_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ request, signature: forwarderSig }),
  });

  const { txHash, error } = await res.json();
  if (error) throw new Error(error);

  // 7. Poll for receipt (non-blocking)
  const receipt = await provider.waitForTransaction(txHash);
  return receipt;
}
```

### gaslessSwapV3 (single-hop)

Same flow as V2. Replace step 2 with:

```js
const swapCalldata = iface.encodeFunctionData("swapV3", [
  tokenIn,
  tokenOut,
  fee,          // 500 | 3000 | 10000
  amountIn,
  amountOutMin,
  swapDeadline,
  permitNonce,
  permitDeadline,
  permitSig,
]);
```

### gaslessSwapV3MultiHop

Path encoding for multi-hop:

```js
// tokenA → tokenB → tokenC
const path = ethers.solidityPacked(
  ["address", "uint24", "address", "uint24", "address"],
  [tokenA, fee1, tokenB, fee2, tokenC]
);

const swapCalldata = iface.encodeFunctionData("swapV3MultiHop", [
  path,
  amountIn,
  amountOutMin,
  swapDeadline,
  permitNonce,
  permitDeadline,
  permitSig,
]);
```

### gaslessSwapBatch (multiple swaps, one signature)

```js
// Each swap in the batch needs its own Permit2 sig
const calls = [
  {
    kind: 0, // V2
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256","uint256","address[]","uint256","uint256","uint256","bytes"],
      [amountIn1, amountOutMin1, path1, deadline1, permitNonce1, permitDeadline1, permitSig1]
    ),
  },
  {
    kind: 1, // V3Single
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ["address","address","uint24","uint256","uint256","uint256","uint256","uint256","bytes"],
      [tokenIn2, tokenOut2, fee2, amountIn2, amountOutMin2, deadline2, permitNonce2, permitDeadline2, permitSig2]
    ),
  },
];

const swapCalldata = iface.encodeFunctionData("swapBatch", [calls]);
// use swapCalldata as request.data in ForwardRequest — same signing flow
```

---

## 8. Backend — Vercel Serverless

### Project structure

```
/api
  relay.js     POST /api/relay
  nonce.js     GET  /api/nonce?address=0x...
vercel.json
package.json
```

### vercel.json

```json
{
  "functions": {
    "api/relay.js": { "maxDuration": 10 },
    "api/nonce.js": { "maxDuration": 10 }
  }
}
```

### CRITICAL: 10-second Vercel timeout rule

Vercel free tier serverless functions timeout after **10 seconds**.
`tx.wait()` waits for on-chain confirmation which can take longer than 10s.

RULE: NEVER call `tx.wait()` in Vercel functions. Always return `tx.hash` immediately.
Let the frontend poll for the receipt using `provider.waitForTransaction(txHash)`.

Wrong:
```js
const receipt = await tx.wait();          // can exceed 10s → Vercel kills function
res.json({ txHash: receipt.hash });
```

Correct:
```js
const tx = await contract.execute(request, signature, { gasLimit });
res.json({ txHash: tx.hash });            // return immediately
// frontend polls: provider.waitForTransaction(txHash)
```

### /api/relay.js

```js
import { ethers } from "ethers";

const ABI = [
  "function execute((address from,uint256 nonce,uint256 gas,bytes data) req, bytes sig) returns (bytes)",
  "function getNonce(address) view returns (uint256)"
];

const RPC_URL          = "https://your-arc-rpc-endpoint";
const CONTRACT_ADDRESS = "0x8E8E5f34405B300E77a0DEbb179CbBD2Fdf91016";

const provider      = new ethers.JsonRpcProvider(RPC_URL);
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
const contract      = new ethers.Contract(CONTRACT_ADDRESS, ABI, relayerWallet);

const ALLOWED_SELECTORS = [
  ethers.id("swapV2(uint256,uint256,address[],uint256,uint256,uint256,bytes)").slice(0, 10),
  ethers.id("swapV3(address,address,uint24,uint256,uint256,uint256,uint256,uint256,bytes)").slice(0, 10),
  ethers.id("swapV3MultiHop(bytes,uint256,uint256,uint256,uint256,uint256,bytes)").slice(0, 10),
  ethers.id("swapBatch((uint8,bytes)[])").slice(0, 10),
];

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "method not allowed" });

  try {
    const { request, signature } = req.body;

    if (!request || !signature)
      return res.status(400).json({ error: "missing request or signature" });

    // selector whitelist
    const selector = request.data?.slice(0, 10);
    if (!ALLOWED_SELECTORS.includes(selector))
      return res.status(400).json({ error: "function not allowed" });

    // on-chain nonce check
    const onChainNonce = await contract.getNonce(request.from);
    if (BigInt(request.nonce) !== onChainNonce)
      return res.status(400).json({ error: "invalid nonce" });

    // submit — DO NOT tx.wait() — Vercel 10s timeout
    const tx = await contract.execute(request, signature, {
      gasLimit: BigInt(request.gas) + 50000n,
    });

    res.json({ txHash: tx.hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
```

### /api/nonce.js

```js
import { ethers } from "ethers";

const RPC_URL          = "https://your-arc-rpc-endpoint";
const CONTRACT_ADDRESS = "0x8E8E5f34405B300E77a0DEbb179CbBD2Fdf91016";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  ["function getNonce(address) view returns (uint256)"],
  provider
);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
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
```

### package.json

```json
{
  "name": "achswap-relayer",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "ethers": "^6.0.0"
  }
}
```

### Environment variables (set in Vercel dashboard, never in code)

Only the private key is sensitive. Everything else is a public value — hardcode it.

```
RELAYER_PRIVATE_KEY = 0x... (hot wallet, gas only — NOT the deployer key)
```

RPC_URL and CONTRACT_ADDRESS are hardcoded directly in the API files:

```js
const RPC_URL          = "https://your-arc-rpc-endpoint";
const CONTRACT_ADDRESS = "0x8E8E5f34405B300E77a0DEbb179CbBD2Fdf91016";
```

### Deploy

```bash
npm i -g vercel
vercel          # follow prompts
# add env vars in Vercel dashboard → Settings → Environment Variables
vercel --prod   # promote to production
```

---

## 9. Relayer vs Owner — Key Distinction

| Role     | Address       | Can call                                        | Risk if leaked         |
|----------|---------------|-------------------------------------------------|------------------------|
| Owner    | Deployer EOA  | pause(), unpause(), rescueTokens()              | Critical — store cold  |
| Relayer  | Hot wallet    | execute(), executeBatch() — anyone can call     | Low — loses gas only   |

The contract enforces NO restriction on who calls execute(). It only validates the
signature inside the request. The relayer cannot steal funds, pause the contract,
or access owner functions.

---

## 10. User Flow Summary

```
1. User calls token.approve(PERMIT2_ADDRESS, MaxUint256)  ← one time per token, user pays gas
2. User signs Permit2 typed message                       ← off-chain, free
3. User signs ForwardRequest typed message                ← off-chain, free
4. Frontend POSTs both sigs to /api/relay                 ← free
5. Relayer calls contract.execute()                       ← relayer pays gas
6. Contract verifies ForwardRequest sig                   ← checks EIP-712 + nonce
7. Contract self-calls swapV2/swapV3 with user appended   ← ERC-2771 pattern
8. swapV2/swapV3 calls Permit2.permitTransferFrom()       ← pulls tokens from user
9. Tokens sent to V2/V3 router, output sent to user       ← swap executes
```

---

## 11. Gas Estimates

| Operation          | Estimated gas |
|--------------------|---------------|
| swapV2 (2-hop)     | ~280,000      |
| swapV3 (single)    | ~220,000      |
| swapV3 (multi-hop) | ~300,000+     |
| executeBatch (5x)  | ~1,200,000    |

Always set `request.gas` 10–20% above estimate. The contract adds 50,000 buffer on
top in the relayer. Total gasLimit sent to chain = `request.gas + 50000`.

---

## 12. Error Reference

| Error                  | Cause                                                        |
|------------------------|--------------------------------------------------------------|
| InvalidSignature       | ForwardRequest sig doesn't match req.from                    |
| InvalidNonce           | req.nonce doesn't match on-chain nonce for req.from          |
| InvalidPath            | path.length < 2, tokenIn == tokenOut, or zero address        |
| ZeroAmount             | amountIn is 0                                                |
| PermitExpired          | permitDeadline < block.timestamp                             |
| DeadlineExpired        | swap deadline < block.timestamp                              |
| InsufficientGas        | gasleft() < req.gas + 40000                                  |
| DirectCallNotAllowed   | swap function called directly, not via execute()             |
| ExecutionFailed(bytes) | inner swap call reverted — bytes contains revert reason      |
| BatchLengthMismatch    | reqs.length != signatures.length in executeBatch             |
| InvalidSwapKind        | SwapCall.kind not 0, 1, or 2                                 |
| "invalid fee tier"     | V3 fee not 500, 3000, or 10000                               |

---

## 13. V3 Router Notes

This contract uses the **original Uniswap V3 SwapRouter** — NOT SwapRouter02.

Original SwapRouter: `deadline` is inside `ExactInputSingleParams` struct.
SwapRouter02:        `deadline` is removed from the struct.

The contract's interface matches the original. If you ever upgrade to SwapRouter02,
remove `deadline` from the `ExactInputSingleParams` struct in the interface and
update the call accordingly. Do not change the external swapV3() function signature —
only the internal interface.

V3 fee tiers enforced: 500 (0.05%), 3000 (0.3%), 10000 (1%).
Pass `sqrtPriceLimitX96 = 0` always (no price cap).

---

## 14. MultiHop Path Encoding

V3 multi-hop path format: `abi.encodePacked(tokenA, fee, tokenB, fee, tokenC)`
- Each token: 20 bytes
- Each fee: 3 bytes (uint24)
- Minimum path length: 43 bytes (one hop)
- Two hops: 66 bytes

```js
// One hop: tokenA → tokenB
const path1 = ethers.solidityPacked(
  ["address", "uint24", "address"],
  [tokenA, 3000, tokenB]
);

// Two hops: tokenA → tokenB → tokenC
const path2 = ethers.solidityPacked(
  ["address", "uint24", "address", "uint24", "address"],
  [tokenA, 3000, tokenB, 500, tokenC]
);
```

tokenIn is always the first 20 bytes. tokenOut is always the last 20 bytes.
The contract extracts them in assembly — no need to pass them separately.

---

## 15. Security Rules — Never Violate

1. Never call `tx.wait()` in Vercel — 10s timeout will kill the function.
2. Never store RELAYER_PRIVATE_KEY in code — Vercel env vars only.
3. Never use the deployer/owner key as the relayer key.
4. Never skip the selector whitelist in the relayer — it's the only thing
   preventing the relayer from being used to call arbitrary functions.
5. Never skip the on-chain nonce check in the relayer — it's a second layer
   preventing replay attacks before hitting the contract.
6. Never change Permit2 nonces to sequential — always random uint256.
7. Never hardcode function selectors — always compute with ethers.id().
8. swapBatch reverts entirely if any swap fails — atomic by design.
9. executeBatch with continueOnFailure=false reverts on first failure — use
   continueOnFailure=true in production to protect other users in the batch.

---

## 16. Checklist for New Features

When adding a new swap function to the contract:
- [ ] Add `if (msg.sender != address(this)) revert DirectCallNotAllowed();`
- [ ] Add `nonReentrant` and `whenNotPaused` modifiers
- [ ] Validate all inputs before any external call
- [ ] Use `_msgSender()` not `msg.sender` to get real user
- [ ] Use `_pullViaPermit2()` helper for token transfer
- [ ] Use `forceApprove(router, amountIn)` before router call
- [ ] Use `forceApprove(router, 0)` after router call
- [ ] Emit event
- [ ] Add selector to ALLOWED_SELECTORS in relayer
- [ ] Add to ABI in this document

