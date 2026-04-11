# Achswap Dex+RWA

A modern decentralized exchange (DEX) frontend built with React, Vite, and Web3 technologies. Achswap supports both Uniswap V2 and V3 style liquidity pools on ARC Testnet.

## Features

- **Token Swaps**: Swap tokens with smart routing across V2 and V3 pools
- **Gasless Swaps**: Relayer-powered swaps using Permit2 - users sign once, relayer pays gas
- **V2 Liquidity**: Add/remove liquidity from V2 style AMM pools
- **V3 Liquidity**: Concentrated liquidity with price range selection (Basic & Advanced modes)
- **V2 to V3 Migration**: Migrate existing V2 LP positions to V3
- **Pool Discovery**: Browse all available V2 and V3 pools with TVL information
- **Wrap/Unwrap**: Convert between native USDC and wrapped wUSDC
- **Transaction History**: Track your recent transactions
- **Smart Routing**: Automatic best path selection across V2/V3 pools
## Quick Start

```bash
# Clone and install
git clone https://github.com/Asif2902/Achswap.git
cd Achswap
npm install

# Configure environment (optional but recommended)
cp .env.example .env
# Edit .env with your WalletConnect Project ID

# Start development server
npm run dev
```

> **Note:** Development server runs at `http://localhost:3000`

---

## Environment Setups

Create a `.env` file in the root directory:

```env
VITE_WALLETCONNECT_PROJECT_ID=your_project_id_here
VITE_ALCHEMY_KEY=your_alchemy_key_here
```

### Server Environment (Vercel)

Set these in **Vercel Project Settings -> Environment Variables**:

| Variable | Required | What to put |
|----------|----------|-------------|
| `GRAPH_QUERY_TOKEN` | Yes | Your The Graph Studio query key (used by `/api/subgraph` and `/api/analytics-summary`) |
| `SUBGRAPH_PROXY_TOKEN` | Recommended | Any strong random secret (for cross-origin proxy auth), e.g. `openssl rand -hex 32` |
| `UPSTASH_REDIS_REST_URL` | Optional | Upstash Redis REST URL for shared rate limiting across serverless instances |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Upstash Redis REST token |
| `SUBGRAPH_RATE_LIMIT_PER_MINUTE` | Optional | Integer request limit per minute (default `240` on `/api/subgraph`) |
| `UPSTREAM_TIMEOUT_MS` | Optional | Integer upstream timeout in milliseconds (default `5000`) |

Important notes:
- `SUBGRAPH_PROXY_TOKEN` is **not** your Graph key.
- `GRAPH_QUERY_TOKEN` is the Graph key used server-side when proxying requests.
- The proxy endpoints now require auth; set `VITE_SUBGRAPH_PROXY_TOKEN` on the frontend to the same value as `SUBGRAPH_PROXY_TOKEN`.

### Frontend Environment (for proxy auth header)

Set in frontend env (local `.env` and Vercel frontend env):

| Variable | Required | What to put |
|----------|----------|-------------|
| `VITE_SUBGRAPH_PROXY_TOKEN` | Yes (with protected proxy) | Same exact value as `SUBGRAPH_PROXY_TOKEN` |

### Getting Required API Keys

**WalletConnect Project ID:**
1. Visit [WalletConnect Cloud](https://cloud.walletconnect.com/)
2. Create a free account and project
3. Copy your Project ID

**Alchemy Key (optional):**
1. Visit [Alchemy](https://www.alchemy.com/)
2. Create a free account and a new app on ARC Testnet
3. Copy your API Key
4. If not provided, public RPC will be used as fallback

---

## Network Configuration

### ARC Testnet (Chain ID: 5042002)

| Property | Value |
|----------|-------|
| Native Token | USDC (18 decimals) |
| Wrapped Token | wUSDC (18 decimals) |
| RPC URL | https://rpc.testnet.arc.network |
| Explorer | https://testnet.arcscan.app |

### Contract Addresses

#### Gasless Swap

| Contract | Address |
|---------|---------|
| AchSwapGasless | `0x32a484dfFB67F4aABB14048248E1DC31F40FF957` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

#### V2 Contracts
| Contract | Address |
|----------|---------|
| Factory | `0x7cC023C7184810B84657D55c1943eBfF8603B72B` |
| Router | `0xB92428D440c335546b69138F7fAF689F5ba8D436` |

#### V3 Contracts
| Contract | Address |
|----------|---------|
| Factory | `0x65fa500712D451b521bA114a4D3962565969F06a` |
| Swap Router | `0x8ceD4213F72dEB449a9e2D9855bDF4b9e2e913B6` |
| Nonfungible Position Manager | `0x6Fe6e80B655fDa474981e16EE43b12131C987d46` |
| Quoter V2 | `0xcC3d26f4811B6861cD8fD2BC547629D6701c6F5F` |
| Migrator | `0x859d886319C75eD6Ec3d9f31e8d68802Fdb04D1B` |
| Position Descriptor | `0xB84c064010144a83d2D044A00395B7aDEd1101a3` |
| Tick Lens | `0x3ac9B673114477CEf52bfc8E3f9a7dcb767C8c3a` |

### Supported Tokens

| Token | Symbol | Address | Decimals |
|-------|--------|---------|----------|
| USDC (Native) | USDC | `0x0000000000000000000000000000000000000000` | 18 |
| USDC (ERC20) | USDC | `0x3600000000000000000000000000000000000000` | 6 |
| Wrapped USDC | wUSDC | `0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA` | 18 |
| Achswap Token | ACHS | `0x45Bb5425f293bdd209c894364C462421FF5FfA48` | 18 |

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot-reload |
| `npm run build` | Build optimized production bundle |
| `npm run start` | Serve production build |
| `npm run check` | Run TypeScript type checking |

---

## Project Structure

```
client/src/
├── components/           # React components
│   ├── ui/             # shadcn/ui components
│   ├── AddLiquidityV2.tsx
│   ├── AddLiquidityV3Basic.tsx
│   ├── AddLiquidityV3Advanced.tsx
│   ├── MigrateV2ToV3.tsx
│   ├── RemoveLiquidityV2.tsx
│   ├── RemoveLiquidityV3.tsx
│   ├── TokenSelector.tsx
│   ├── SwapSettings.tsx
│   ├── PathVisualizer.tsx
│   ├── PriceRangeChart.tsx
│   ├── TransactionHistory.tsx
│   ├── V3ContractStatus.tsx
│   ├── WrapUnwrapModal.tsx
│   ├── PoolHealthChecker.tsx
│   └── Header.tsx
├── pages/               # Main application pages
│   ├── Swap.tsx
│   ├── AddLiquidity.tsx
│   ├── RemoveLiquidity.tsx
│   └── Pools.tsx
├── lib/                 # Utility libraries
│   ├── abis/v3.ts      # V3 contract ABIs
│   ├── contracts.ts    # Contract addresses
│   ├── wagmi.ts        # Wagmi/RainbowKit config
│   ├── v3-utils.ts     # V3 math utilities
│   ├── pool-utils.ts   # V2 pool utilities
│   ├── smart-routing.ts
│   └── config.ts       # RPC configuration
├── data/
│   └── tokens.ts       # Token definitions
└── hooks/              # Custom React hooks
```

---

## Technology Stack

| Category | Technology |
|----------|------------|
| Framework | React 18.3.1 |
| Build Tool | Vite 5.4.20 |
| Language | TypeScript 5.6.3 |
| Styling | Tailwind CSS 3.4.17 |
| Web3 | wagmi 2.12.0, viem 2.21.0 |
| Wallet | RainbowKit 2.1.6 |
| State | Zustand 5.0.11 |
| Charts | Recharts 2.15.2 |

---

## Key Features Explained

### Smart Routing
The swap interface automatically finds the best route across V2 and V3 pools:
- Compares quotes from both V2 and V3 pools
- Routes through the pool with the best price
- Visualizes the routing path for transparency
- Price impact protection
### V3 Concentrated Liquidity
- **Basic Mode**: Preset fee tiers (0.05%, 0.3%, 1%) with suggested price ranges
- **Advanced Mode**: Custom tick selection with full control
- **Pool Health Checker**: Real-time diagnostics with auto-fix suggestions

### V2 to V3 Migration
- View all V2 LP positions
- One-click migration to V3
- Automatic approval and liquidity management
- Fixed Max buttons

### Gasless Swaps
- Users can enable "Zap" mode for gasless swaps
- Uses Permit2 for token approvals - one-time approval, then unlimited swaps
- Relayer executes the transaction, user pays no gas
- Native USDC (0x0000...) is auto-wrapped via contract
- Works with V2 and V3 single-hop routes
- Gasless preference is saved in localStorage

---

## Adding New Tokens

Add tokens to `client/src/data/tokens.ts`:

```typescript
{
  address: "0x...",
  name: "Token Name",
  symbol: "SYM",
  decimals: 18,
  logoURI: "/img/logos/token.png",
  verified: true,
  chainId: 5042002
}
```

For wrapped token pairs, also update `wrappedTokenMap` and `unwrappedTokenMap`:

```typescript
export const wrappedTokenMap: Record<number, Record<string, string>> = {
  5042002: {
    "0x.native.address": "0x.wrapped.address",
  },
};
```

---

## Troubleshooting

### Wallet Connection Issues
- Ensure your wallet is connected to ARC Testnet (Chain ID: 5042002)
- Verify WalletConnect Project ID is set in `.env`
- Try clearing wallet connection cache and reconnecting

### Transaction Failures
- Ensure sufficient USDC balance for gas
- Check if token allowances are set
- Verify slippage settings in Swap Settings

### Pool Not Found
- V3 pools must be initialized before adding liquidity
- Use Pool Health Checker to diagnose issues

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

GNU General Public License v3.0 - see LICENSE file for details
