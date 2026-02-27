# Achswap DEX

A modern decentralized exchange (DEX) frontend built with React, Vite, and Web3 technologies. Achswap supports both Uniswap V2 and V3 style liquidity pools on ARC Testnet.

## Features

- **Token Swaps**: Swap tokens with smart routing across V2 and V3 pools
- **V2 Liquidity**: Add/remove liquidity from V2 style AMM pools
- **V3 Liquidity**: Concentrated liquidity with price range selection (Basic & Advanced modes)
- **V2 to V3 Migration**: Migrate existing V2 LP positions to V3
- **Pool Discovery**: Browse all available V2 and V3 pools with TVL information
- **Wrap/Unwrap**: Convert between native USDC and wrapped wUSDC
- **Transaction History**: Track your recent transactions
- **Smart Routing**: Automatic best path selection across V2/V3 pools

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn package manager
- A Web3 wallet (MetaMask, Rainbow, or any WalletConnect-compatible wallet)

### Quick Start

#### 1. Clone the Repository

```bash
git clone https://github.com/Asif2902/Achswap.git
cd Achswap
```

#### 2. Install Dependencies

```bash
npm install
```

#### 3. Set Up Environment Variables

Create a `.env` file in the root directory:

```env
VITE_WALLETCONNECT_PROJECT_ID=your_project_id_here
VITE_ALCHEMY_KEY=your_alchemy_key_here
```

> **Get your WalletConnect Project ID:**
> 1. Visit [WalletConnect Cloud](https://cloud.walletconnect.com/)
> 2. Create a free account and project
> 3. Copy your Project ID
>
> **Get your Alchemy Key (optional):**
> 1. Visit [Alchemy](https://www.alchemy.com/)
> 2. Create a free account and a new app on ARC Testnet
> 3. Copy your API Key
> - If not provided, public RPC will be used as fallback

#### 4. Run Development Server

```bash
npm run dev
```

Development server runs at: `http://localhost:3000`

---

### Production Build

```bash
npm run build
npm start
```

---

### Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot-reload |
| `npm run build` | Build optimized production bundle |
| `npm start` | Serve production build |
| `npm run check` | Run TypeScript type checking |

---

## Supported Network

### ARC Testnet (Chain ID: 5042002)

| Property | Value |
|----------|-------|
| Native Token | USDC (18 decimals) |
| Wrapped Token | wUSDC (18 decimals) |
| RPC URL | https://rpc.testnet.arc.network |
| Explorer | https://testnet.arcscan.app |

### Contract Addresses

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

| Token | Symbol | Address |
|-------|--------|---------|
| USDC (Native) | USDC | `0x0000000000000000000000000000000000000000` |
| Wrapped USDC | wUSDC | `0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA` |
| Achswap Token | ACHS | `0x45Bb5425f293bdd209c894364C462421FF5FfA48` |

---

## Project Structure

```
client/
  src/
    components/          # React components
      ui/               # shadcn/ui components
      AddLiquidityV2.tsx
      AddLiquidityV3Basic.tsx
      AddLiquidityV3Advanced.tsx
      MigrateV2ToV3.tsx
      RemoveLiquidityV2.tsx
      RemoveLiquidityV3.tsx
      TokenSelector.tsx
      SwapSettings.tsx
      PathVisualizer.tsx
      PriceRangeChart.tsx
      TransactionHistory.tsx
      V3ContractStatus.tsx
      WrapUnwrapModal.tsx
      PoolHealthChecker.tsx    # V3 pool health diagnostics
      Header.tsx
    pages/              # Main application pages
      Swap.tsx
      AddLiquidity.tsx
      RemoveLiquidity.tsx
      Pools.tsx
      not-found.tsx
    lib/                # Utility libraries
      abis/
        v3.ts          # V3 contract ABIs
      contracts.ts     # Contract addresses by chain
      wagmi.ts         # Wagmi/RainbowKit config
      v3-utils.ts       # V3 math utilities
      v3-pool-utils.ts  # V3 pool utilities
      v3-liquidity-math.ts
      pool-utils.ts     # V2 pool utilities
      pool-apr-utils.ts # APR calculation utilities
      smart-routing.ts  # Smart routing logic
      quote-cache.ts    # Quote caching
      dex-settings.ts   # DEX settings management
      decimal-utils.ts  # Decimal handling
      ticklens-utils.ts # Tick lens utilities
      config.ts         # RPC configuration with Alchemy support
      error-utils.ts    # Error handling utilities
      queryClient.ts    # React Query client
    data/
      tokens.ts         # Token definitions
    hooks/              # Custom React hooks
      use-toast.ts      # Toast notification hook
      use-mobile.tsx    # Mobile detection hook
```

---

## Technology Stack

| Category | Technology |
|----------|------------|
| Framework | React 18.3.1 |
| Build Tool | Vite 5.4.20 |
| Language | TypeScript 5.6.3 |
| Styling | Tailwind CSS 3.4.17 |
| UI Components | Radix UI + shadcn/ui |
| Web3 | wagmi 2.12.0, viem 2.21.0 |
| Wallet Connection | RainbowKit 2.1.6 |
| Blockchain | ethers 6.13.4 |
| Routing | wouter 3.3.5 |
| State Management | Zustand 5.0.11 |
| Charts | Recharts 2.15.2 |
| Data Fetching | TanStack React Query 5.90.10 |
| Animations | Framer Motion 11.13.1 |
| Date Handling | date-fns 3.6.0 |
| Form Validation | react-hook-form + Zod |

---

## Key Features Explained

### Smart Routing

The swap interface automatically finds the best route across V2 and V3 pools:
- Compares quotes from both V2 and V3 pools
- Routes through the pool with the best price
- Visualizes the routing path for transparency

### V3 Liquidity

Concentrated liquidity allows LPs to select price ranges:
- **Basic Mode**: Preset fee tiers (0.05%, 0.3%, 1%) with suggested price ranges
- **Advanced Mode**: Custom tick selection with full control
- **Price Range Chart**: Visual representation of liquidity distribution
- **Pool Health Checker**: Real-time pool health diagnostics with auto-fix suggestions

### V2 to V3 Migration

Migrate existing V2 LP positions to V3:
- View all V2 LP positions
- One-click migration to V3 with selected fee tier and price range
- Automatic approval and liquidity removal/addition

### Pool Discovery

Browse all available pools:
- V2 and V3 pool listings
- TVL (Total Value Locked) display
- **APR Calculation**: Estimated yearly returns for V3 positions
- Search by token name or address
- Pool reserves and fee information

---

## Recent Updates

### v1.1.0 - Pool Health & APR

- **Pool Health Checker**: New component that validates V3 pools for common issues (uninitialized pools, extreme prices, price mismatches, no active liquidity)
- **APR Display**: Added estimated APR calculation for V3 LP positions with volume-based estimation when TVL is low
- **Auto-fix Capabilities**: Pool health issues that can be auto-fixed show an "Auto Fix" button

### v1.0.x - Stability & Performance

- **Alchemy RPC Integration**: Added Alchemy private RPC support for improved reliability
- **Fallback RPC**: Automatic fallback to public RPC when primary fails
- **Retry Logic**: Added retry logic with exponential backoff for RPC calls
- **Error Handling**: Improved error handling across all transactions
- **Precision Fixes**: Fixed precision issues with MAX button and token amounts
- **Race Condition Fixes**: Resolved race conditions in quote fetching and pool data

---

## Architecture

- **Frontend-Only**: No backend server required; all blockchain interactions via RPC
- **Multi-Protocol**: Single codebase supports both V2 and V3 DEX protocols
- **Wallet Integration**: RainbowKit handles wallet connections with multiple wallet support
- **Decimal Agnostic**: All math operations handle different token decimals automatically
- **Production Ready**: Gas optimization, error handling, and user feedback on all operations

---

## Development Notes

### Adding New Tokens

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

If adding a wrapped token pair, also update `wrappedTokenMap` and `unwrappedTokenMap`:

```typescript
export const wrappedTokenMap: Record<number, Record<string, string>> = {
  5042002: {
    "0x.native.address": "0x.wrapped.address",
  },
};

export const unwrappedTokenMap: Record<number, Record<string, string>> = {
  5042002: {
    "0x.wrapped.address": "0x.native.address",
  },
};
```

### Adding New Chains

1. Define the chain in `client/src/lib/wagmi.ts`
2. Add contract addresses in `client/src/lib/contracts.ts`
3. Add tokens in `client/src/data/tokens.ts`
4. Add wrapped token mappings if applicable

---

## Known Limitations

- WalletConnect requires a valid Project ID for full wallet connectivity
- Token import requires a valid ERC20 contract address on the current chain
- V3 pools require the pool to be initialized before adding liquidity

---
