export const GASLESS_CONFIG = {
  contractAddress: "0xD65B535A6cd27657C19720759F7C6f3F89eEf734",
  permit2Address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  relayerUrl: "https://preview.achswapfi.xyz/api/relay",
  nonceUrl: "https://preview.achswapfi.xyz/api/nonce",
};

export const NATIVE_TOKEN = "0x3600000000000000000000000000000000000000"; // USDC_NATIVE - ERC20 on Arc

export const GASLESS_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "totalAmountIn", type: "uint256" },
      { name: "permitNonce", type: "uint256" },
      { name: "permitDeadline", type: "uint256" },
      { name: "permitSig", type: "bytes" },
      {
        name: "segment",
        type: "tuple",
        components: [
          { name: "kind", type: "uint8" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMin", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "params", type: "bytes" }
        ]
      }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "executeSplit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "totalAmountIn", type: "uint256" },
      { name: "permitNonce", type: "uint256" },
      { name: "permitDeadline", type: "uint256" },
      { name: "permitSig", type: "bytes" },
      {
        name: "segments",
        type: "tuple[]",
        components: [
          { name: "kind", type: "uint8" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMin", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "params", type: "bytes" }
        ]
      }
    ]
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
