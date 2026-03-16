export const GASLESS_CONFIG = {
  contractAddress: "0x4bde23d3094334a9ebBc3733178ec1414F5332Bb",
  permit2Address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  relayerUrl: "https://preview.achswapfi.xyz/api/relay",
  nonceUrl: "https://preview.achswapfi.xyz/api/nonce",
};

export const NATIVE_TOKEN_WRAPPER = "0x3600000000000000000000000000000000000000";

export const GASLESS_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [{ name: "from", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "req",
        type: "tuple",
        components: [
          { name: "from", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "gas", type: "uint256" },
          { name: "data", type: "bytes" }
        ]
      },
      { name: "signature", type: "bytes" }
    ],
    outputs: [{ name: "returndata", type: "bytes" }]
  },
  {
    type: "function",
    name: "swapV2",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "swapV3",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "swapV3MultiHop",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "permitNonce", type: "uint256" },
      { name: "permitDeadline", type: "uint256" },
      { name: "permitSig", type: "bytes" }
    ],
    outputs: []
  }
];

export const PERMIT2_ABI = [
  {
    type: "function",
    name: "permitTransferFrom",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "permitted", type: "tuple", components: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" }
          ]},
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: []
  }
];

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

export const CHAIN_ID = 5042002; // Arc Testnet
