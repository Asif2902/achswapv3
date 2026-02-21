# Uniswap V2 & V3 — AI Context Rules & Contract Reference

> **Why this document exists:** AI systems consistently break Uniswap V3 UIs and calculations because they confuse V3 concepts with V2 ones, mishandle the `sqrtPriceX96` fixed-point math, use wrong BigInt handling, and make changes to one part of the code without understanding how it flows into the rest. This document tells the AI what it must understand and verify *before* touching any code.

---

## THE GOLDEN RULE — READ BEFORE EVERY TASK

> **Before modifying ANY logic, calculation, UI value, or contract call — stop and trace the full data flow from the contract call to what is displayed on screen. A change in one formula silently breaks five other things in V3. Understand the whole chain first.**

---

## TABLE OF CONTENTS

1. [How to Think Before You Code](#1-how-to-think-before-you-code)
2. [V2 vs V3 — Architectural Differences Table](#2-v2-vs-v3-architectural-differences)
3. [Uniswap V2 — Core Contracts Reference](#3-v2-core-contracts)
4. [Uniswap V2 — Periphery Contracts Reference](#4-v2-periphery-contracts)
5. [Uniswap V2 — Math You Must Know](#5-v2-math)
6. [Uniswap V3 — Core Contracts Reference](#6-v3-core-contracts)
7. [Uniswap V3 — Periphery Contracts Reference](#7-v3-periphery-contracts)
8. [V3 — The sqrtPriceX96 System (Most Misunderstood Part)](#8-sqrtpricex96)
9. [V3 — Ticks (Second Most Misunderstood Part)](#9-ticks)
10. [V3 — Liquidity Math](#10-v3-liquidity-math)
11. [V3 — Fee Tiers & Tick Spacing](#11-fee-tiers--tick-spacing)
12. [V3 — Positions (NFT-Based, Not ERC20)](#12-v3-positions)
13. [V3 — Fee Collection Flow (3-Step, Always)](#13-v3-fee-collection-flow)
14. [V3 — SwapRouter vs SwapRouter02 (They Are Different)](#14-swaprouter-vs-swaprouter02)
15. [BigInt & Precision Rules](#15-bigint--precision-rules)
16. [UI Display Rules — What to Show and How](#16-ui-display-rules)
17. [Contract Addresses — Ethereum Mainnet](#17-contract-addresses)
18. [The Banned Patterns List](#18-banned-patterns)
19. [Pre-Task Checklist](#19-pre-task-checklist)

---

## 1. HOW TO THINK BEFORE YOU CODE

When a task involves Uniswap V3, the AI **must** answer every question below before writing or changing any code:

### Questions to answer before touching V3 logic

**1. Which version is this?**
V2 and V3 are completely different protocols. They share no math, no contract interfaces, and no price representation. Mixing them breaks everything silently.

**2. What is the token ordering?**
Both V2 and V3 use `token0` / `token1` ordering based on address sort order. `token0` is always the address with the lower hex value. This is determined at pool creation and never changes. If you display `token0` price as "token A per token B" and the user inputted "token B / token A", every price on screen will be wrong.

**3. What decimals does each token have?**
`sqrtPriceX96`, `reserve0`, `reserve1`, `liquidity` — all of these are in raw integers with no decimal adjustment. If you don't divide by `10^decimals` for each token at the right step, every number shown is wrong by orders of magnitude.

**4. In V3: what is the current price representation?**
V3 stores price as `sqrtPriceX96`. This is a `Q64.96` fixed-point number. It is NOT the price. It is NOT the sqrt of the human-readable price. You must decode it (see Section 8) before displaying or using it anywhere.

**5. In V3: what are the position's tick bounds?**
`tickLower` and `tickUpper` define the price range. Whether the position is in-range, out-of-range, or at the boundary determines WHICH formula you use to calculate token amounts. Getting this wrong makes token amount displays incorrect.

**6. In V3: what did the last code change affect?**
V3 has a deeply connected chain: `sqrtPriceX96` → `tick` → `tickLower/tickUpper` → `liquidity` → `amount0/amount1` → `feeGrowth` → `tokensOwed`. If you change the price decoding, you have also affected position amounts, range status, and fee calculations. Trace it.

**7. Does this involve a fee collection, decrease, or burn?**
In V3, collecting fees requires a specific 3-step sequence. Burning without collecting first loses fees. Changing the sequence breaks it.

**8. Which router is being used?**
`SwapRouter` (old) and `SwapRouter02` (new) have different parameter structs. `SwapRouter02`'s `ExactInputSingleParams` does NOT have a `deadline` field. Using the wrong struct silently fails.

---

## 2. V2 VS V3 ARCHITECTURAL DIFFERENCES

| Concept | V2 | V3 |
|---|---|---|
| **Price storage** | Implicit: `reserve1 / reserve0` | Explicit: `sqrtPriceX96` in `slot0` (Q64.96 fixed-point) |
| **LP token type** | ERC20 (fungible, shared supply) | ERC721 NFT (each position is unique) |
| **Liquidity range** | Uniform across `[0, ∞)` | Concentrated: user-defined `[tickLower, tickUpper]` |
| **Pool per pair** | One pool per token pair | One pool per token pair + fee tier (multiple pools possible) |
| **Fee tiers** | Fixed 0.3% only | 0.01% (100), 0.05% (500), 0.3% (3000), 1% (10000) |
| **Pool address** | `factory.getPair(tokenA, tokenB)` | `factory.getPool(tokenA, tokenB, fee)` |
| **Current price** | `reserve1 / reserve0` (adjusted for decimals) | Decode `sqrtPriceX96` (see Section 8) |
| **Swap entry point** | `UniswapV2Router02` | `SwapRouter` or `SwapRouter02` |
| **Quote method** | Off-chain with reserves | On-chain `QuoterV2.quoteExactInputSingle()` (simulates) |
| **Fee collection** | Auto on remove liquidity | Manual 3-step: `burn(0)` → `collect()` |
| **Oracle** | `price0CumulativeLast` | TWAP via `observe(secondsAgos)` |
| **Tick system** | None | Central to everything |

---

## 3. V2 CORE CONTRACTS

### UniswapV2Factory

```
getPair(tokenA, tokenB) → address   // returns address(0) if no pair
createPair(tokenA, tokenB) → address
allPairs(uint) → address
allPairsLength() → uint
```

**Rules:**
- `getPair` returns `address(0)` if the pair doesn't exist. Always check for zero address.
- Token order in `getPair` doesn't matter — it normalizes internally.
- Each unique token pair has exactly ONE pool in V2 (unlike V3 where one pool exists per fee tier).

---

### UniswapV2Pair

```solidity
function token0() external view returns (address);   // always the lower-sorted address
function token1() external view returns (address);
function getReserves() external view returns (
    uint112 reserve0,
    uint112 reserve1,
    uint32 blockTimestampLast
);
function totalSupply() external view returns (uint);
```

**Rules:**
- `token0` is ALWAYS the address that is numerically smaller in hex. `token1` is larger. This is set at pair creation and never changes.
- `reserve0` corresponds to `token0`. `reserve1` corresponds to `token1`. Do not swap them.
- `blockTimestampLast` wraps around at `2^32`. Do not use for time arithmetic without overflow handling.
- `reserve0` and `reserve1` are `uint112` — max ~5.19 × 10^33. Extremely high-supply tokens can overflow.
- `MINIMUM_LIQUIDITY = 1000` is permanently burned to `address(0)` on the first mint. The first LP always loses 1000 wei of LP tokens.
- **Never call `swap()` directly.** It sends output before receiving input (optimistic). Always use the router.

---

## 4. V2 PERIPHERY CONTRACTS

### UniswapV2Router02 (entry point for all user operations)

**Swap functions:**
```solidity
swapExactTokensForTokens(amountIn, amountOutMin, path[], to, deadline)
swapTokensForExactTokens(amountOut, amountInMax, path[], to, deadline)
swapExactETHForTokens(amountOutMin, path[], to, deadline) payable
swapTokensForExactETH(amountOut, amountInMax, path[], to, deadline)
swapExactTokensForETH(amountIn, amountOutMin, path[], to, deadline)
swapETHForExactTokens(amountOut, path[], to, deadline) payable

// Fee-on-transfer token variants (MUST use for rebasing/deflationary tokens)
swapExactTokensForTokensSupportingFeeOnTransferTokens(...)
swapExactETHForTokensSupportingFeeOnTransferTokens(...) payable
swapExactTokensForETHSupportingFeeOnTransferTokens(...)
```

**Liquidity functions:**
```solidity
addLiquidity(tokenA, tokenB, amtADesired, amtBDesired, amtAMin, amtBMin, to, deadline)
addLiquidityETH(token, amtTokenDesired, amtTokenMin, amtETHMin, to, deadline) payable
removeLiquidity(tokenA, tokenB, liquidity, amtAMin, amtBMin, to, deadline)
removeLiquidityETH(token, liquidity, amtTokenMin, amtETHMin, to, deadline)
removeLiquidityWithPermit(...)
```

**Critical rules:**
- `deadline` is a Unix timestamp (seconds). **Never pass `block.timestamp` alone** — that means it never expires. Use `block.timestamp + 300` minimum, or a user-defined expiry.
- `path` must include WETH address for ETH swaps, not the zero address.
- For fee-on-transfer tokens, always use the `SupportingFeeOnTransferTokens` variants or the swap will revert.
- The router uses `amountAMin` / `amountBMin` for slippage. Setting them to `0` means no slippage protection. That is a vulnerability in production.

---

## 5. V2 MATH

### Price from reserves (human-readable)

```js
// Raw ratio (token1 per token0, before decimal adjustment)
const rawPrice = reserve1 / reserve0;

// Human-readable price (token1 per token0)
const price = (reserve1 / 10**decimals1) / (reserve0 / 10**decimals0);

// Human-readable price (token0 per token1)
const inversePrice = (reserve0 / 10**decimals0) / (reserve1 / 10**decimals1);
```

### getAmountOut (exact input swap)
```js
// V2 charges a 0.3% fee (997/1000 of input reaches the pool)
function getAmountOut(amountIn, reserveIn, reserveOut) {
    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = (reserveIn * 1000n) + amountInWithFee;
    return numerator / denominator;
}
```

### getAmountIn (exact output swap)
```js
function getAmountIn(amountOut, reserveIn, reserveOut) {
    const numerator = reserveIn * amountOut * 1000n;
    const denominator = (reserveOut - amountOut) * 997n;
    return (numerator / denominator) + 1n;
}
```

**All of this must use BigInt.** Never use regular floats for this — `reserve0` and `reserve1` are `uint112` values that overflow `Number.MAX_SAFE_INTEGER`.

---

## 6. V3 CORE CONTRACTS

### UniswapV3Factory

```solidity
function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
```

**Critical difference from V2:** In V3, each token pair can have **multiple pools**, one per fee tier. `getPool` requires the fee tier. A WETH/USDC pool at 0.05% is a completely different contract address than WETH/USDC at 0.3%.

---

### UniswapV3Pool — slot0 (the most important call)

```solidity
function slot0() external view returns (
    uint160 sqrtPriceX96,    // current price as Q64.96 sqrt. NOT human price. Decode it (Section 8).
    int24 tick,              // current tick. May NOT equal getTickAtSqrtRatio(sqrtPriceX96) — use sqrtPriceX96 for precision.
    uint16 observationIndex,
    uint16 observationCardinality,
    uint16 observationCardinalityNext,
    uint8 feeProtocol,       // protocol fee split. Encoded: lower 4 bits = token0, upper 4 bits = token1.
    bool unlocked            // reentrancy lock. If false, the pool is being used mid-swap.
);
```

**CRITICAL:** The `tick` in `slot0` can be one tick off from the actual current price due to integer rounding. For price display, **always decode from `sqrtPriceX96`**, not from `tick`.

---

### UniswapV3Pool — other key reads

```solidity
function liquidity() external view returns (uint128);
// Current in-range liquidity ONLY. Does NOT include out-of-range positions.

function ticks(int24 tick) external view returns (
    uint128 liquidityGross,           // total liquidity at this tick boundary
    int128 liquidityNet,              // liquidity added/removed when tick is crossed (+ = enter, - = exit)
    uint256 feeGrowthOutside0X128,    // fee growth (token0) outside this tick, as Q128.128
    uint256 feeGrowthOutside1X128,    // fee growth (token1) outside this tick
    int56 tickCumulativeOutside,
    uint160 secondsPerLiquidityOutsideX128,
    uint32 secondsOutside,
    bool initialized                  // whether this tick has ever been used
);

function feeGrowthGlobal0X128() external view returns (uint256); // Q128.128, can overflow uint256 (by design)
function feeGrowthGlobal1X128() external view returns (uint256); // Q128.128, can overflow uint256 (by design)

function positions(bytes32 key) external view returns (
    uint128 liquidity,
    uint256 feeGrowthInside0LastX128,
    uint256 feeGrowthInside1LastX128,
    uint128 tokensOwed0,   // fees accrued but not yet collected
    uint128 tokensOwed1
);
// Position key = keccak256(abi.encodePacked(owner, tickLower, tickUpper))
// For NonfungiblePositionManager positions, owner = NonfungiblePositionManager address

function observe(uint32[] calldata secondsAgos) external view returns (
    int56[] memory tickCumulatives,
    uint160[] memory secondsPerLiquidityCumulativeX128s
);
// For TWAP: call with [3600, 0] to get 1-hour average
// TWAP tick = (tickCumulatives[1] - tickCumulatives[0]) / (secondsAgos[0] - secondsAgos[1])
```

---

### UniswapV3Pool — write functions (low-level, almost never call directly)

```solidity
function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
    external returns (uint256 amount0, uint256 amount1);
// Triggers uniswapV3MintCallback. Use NonfungiblePositionManager instead.

function burn(int24 tickLower, int24 tickUpper, uint128 amount)
    external returns (uint256 amount0, uint256 amount1);
// Does NOT transfer tokens. Only updates tokensOwed in the position. Must follow with collect().

function collect(address recipient, int24 tickLower, int24 tickUpper,
    uint128 amount0Requested, uint128 amount1Requested)
    external returns (uint128 amount0, uint128 amount1);
// Transfers tokens. Must call burn() (even burn(0)) first to update feeGrowth.

function swap(address recipient, bool zeroForOne, int256 amountSpecified,
    uint160 sqrtPriceLimitX96, bytes calldata data)
    external returns (int256 amount0, int256 amount1);
// Never call directly. Use SwapRouter.
```

---

## 7. V3 PERIPHERY CONTRACTS

### NonfungiblePositionManager (main LP entry point)

```solidity
// MintParams struct
struct MintParams {
    address token0;
    address token1;
    uint24 fee;
    int24 tickLower;          // must be divisible by the pool's tickSpacing
    int24 tickUpper;          // must be divisible by the pool's tickSpacing
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    address recipient;
    uint256 deadline;
}
function mint(MintParams calldata params)
    external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

// Reading a position
function positions(uint256 tokenId) external view returns (
    uint96 nonce,
    address operator,
    address token0,
    address token1,
    uint24 fee,
    int24 tickLower,
    int24 tickUpper,
    uint128 liquidity,
    uint256 feeGrowthInside0LastX128,  // snapshot of fee growth at last update
    uint256 feeGrowthInside1LastX128,
    uint128 tokensOwed0,   // uncollected fees in token0
    uint128 tokensOwed1    // uncollected fees in token1
);

// IncreaseLiquidityParams
struct IncreaseLiquidityParams {
    uint256 tokenId;
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    uint256 deadline;
}
function increaseLiquidity(IncreaseLiquidityParams calldata params)
    external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);

// DecreaseLiquidityParams
struct DecreaseLiquidityParams {
    uint256 tokenId;
    uint128 liquidity;     // amount of liquidity to remove (uint128, not uint256)
    uint256 amount0Min;
    uint256 amount1Min;
    uint256 deadline;
}
function decreaseLiquidity(DecreaseLiquidityParams calldata params)
    external payable returns (uint256 amount0, uint256 amount1);
// decreaseLiquidity does NOT send tokens to you. It updates tokensOwed. You must call collect() after.

// CollectParams
struct CollectParams {
    uint256 tokenId;
    address recipient;
    uint128 amount0Max;    // pass type(uint128).max to collect all
    uint128 amount1Max;    // pass type(uint128).max to collect all
}
function collect(CollectParams calldata params)
    external payable returns (uint256 amount0, uint256 amount1);

// Burn NFT (only after removing all liquidity and collecting all fees)
function burn(uint256 tokenId) external payable;
```

**Critical rules for NonfungiblePositionManager:**
- `token0` and `token1` in `MintParams` must be in the correct sorted order (lower address first). Passing them in wrong order will revert or create a position on the wrong pool.
- `tickLower` and `tickUpper` **must be divisible by the pool's `tickSpacing`**. If they're not, the transaction reverts. (See Section 11.)
- Calling `burn(tokenId)` will revert if the position still has `liquidity > 0` or `tokensOwed > 0`. You must fully exit first.
- The `positions()` read returns `tokensOwed` which is only updated when `mint`, `burn`, or `collect` is called. It does NOT auto-accumulate in real-time from the contract read alone. To see real-time uncollected fees, you must call `burn(tickLower, tickUpper, 0)` on the pool first (a zero-burn to trigger state update), or compute it via the feeGrowth math.

---

### SwapRouter (original — `0xE592427A0AEce92De3Edee1F18E0157C05861564`)

```solidity
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 deadline;         // ← HAS deadline
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

struct ExactOutputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 deadline;         // ← HAS deadline
    uint256 amountOut;
    uint256 amountInMaximum;
    uint160 sqrtPriceLimitX96;
}

// Multi-hop paths
struct ExactInputParams {
    bytes path;               // abi.encodePacked(tokenA, fee, tokenB, fee, tokenC)
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
}
```

---

### SwapRouter02 (newer — `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`)

```solidity
// ExactInputSingleParams in SwapRouter02 is DIFFERENT
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    // NO deadline field here — deadline was removed in SwapRouter02
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}
```

> **⛔ This is one of the most common silent failures.** If you copy `SwapRouter` code to use with `SwapRouter02`, the struct mismatch causes a revert with a confusing error or Metamask warning. Always check which router address is being used and match the exact struct definition.

---

## 8. sqrtPriceX96

### What it is

`sqrtPriceX96` is stored as a `Q64.96` fixed-point integer. It equals:

```
sqrtPriceX96 = sqrt(price_token1_per_token0) * 2^96
```

The price here is always `token1 / token0` — the amount of `token1` per 1 unit of `token0` in raw wei, before decimal adjustment.

### How to decode to human-readable price

```js
// Step 1: convert sqrtPriceX96 to a float sqrt
// ALWAYS use BigInt for this — sqrtPriceX96 is uint160, far exceeds Number.MAX_SAFE_INTEGER

const Q96 = 2n ** 96n;

// Step 2: get the raw price ratio (token1 wei / token0 wei)
function getRawPrice(sqrtPriceX96) {
    // sqrtPriceX96 must be BigInt
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
    return sqrtPrice * sqrtPrice;
}

// Step 3: adjust for decimals to get human-readable price
function getHumanPrice(sqrtPriceX96, decimals0, decimals1) {
    const rawPrice = getRawPrice(sqrtPriceX96);
    // rawPrice = (token1 wei) / (token0 wei)
    // Human price = rawPrice * (10^decimals0 / 10^decimals1)
    return rawPrice * (10 ** decimals0) / (10 ** decimals1);
    // Result: how many token1 (human units) per 1 token0 (human unit)
}

// Step 4: to get the inverse (token0 per token1):
const inversePrice = 1 / humanPrice;
```

### Safe BigInt version (for high-precision UIs)

```js
// Avoid float precision loss entirely for on-chain math
function getPriceX128(sqrtPriceX96) {
    // price as Q128.128 (useful for fee calculations)
    return (BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96)) >> 64n;
}
```

### Worked example (USDC/ETH pool)
- `sqrtPriceX96 = 2018382873588440326581633304624437n` (from mainnet block 15436494)
- `sqrtPrice = 2018382873588440326581633304624437 / 2^96 = 25482.something`
- `rawPrice = 25482^2 = 649,031,524` — this is WETH-wei per USDC-wei
- Adjust decimals: USDC has 6 decimals, WETH has 18 → multiply by `10^6 / 10^18 = 10^-12`
- `humanPrice = 649,031,524 * 10^-12 ≈ 0.000000649` ETH per USDC → invert → ~1540 USDC per ETH

> **Always verify your direction.** In USDC/WETH where USDC is token0 and WETH is token1, the raw price is ETH-wei per USDC-wei, which is a tiny number. You almost certainly want the inverse.

### Converting price to sqrtPriceX96 (for pool initialization or limit orders)

```js
function priceToSqrtPriceX96(humanPrice, decimals0, decimals1) {
    // Reverse the decimal adjustment
    const rawPrice = humanPrice / (10 ** decimals0) * (10 ** decimals1);
    const sqrtRaw = Math.sqrt(rawPrice);
    return BigInt(Math.floor(sqrtRaw * (2 ** 96)));
}
```

### Absolute price bounds
- `MIN_SQRT_RATIO = 4295128739` (corresponds to ~tick -887272)
- `MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342` (corresponds to ~tick +887272)
- If you set `sqrtPriceLimitX96` to 0 in a swap call, the price limit is disabled.
- For a `zeroForOne` swap, `sqrtPriceLimitX96` must be **less than** the current `sqrtPriceX96` and **greater than** `MIN_SQRT_RATIO`.
- For a one-for-zero swap, it must be **greater than** current and **less than** `MAX_SQRT_RATIO`.

---

## 9. TICKS

### What is a tick

A tick is an integer representing a discrete price level. Each tick spacing of 1 represents a 0.01% price change:

```
price_at_tick = 1.0001^tick
tick_from_price = floor( log(price) / log(1.0001) )
```

### Tick bounds
- `MIN_TICK = -887272`
- `MAX_TICK = 887272`
- These correspond to the extreme price ratios the pool supports.

### The tick in slot0 vs sqrtPriceX96
The `tick` stored in `slot0` is the FLOOR of the true current tick. The `sqrtPriceX96` can represent any price within a tick interval. This is why:
- **Use `sqrtPriceX96` for price display** — it's precise.
- **Use `tick` from `slot0` for range comparisons** — it's sufficient for checking if a position is in/out of range.
- `tick = Math.floor(Math.log(Number(sqrtPriceX96) / 2**96) ** 2 / Math.log(1.0001))`

### In-range check

```js
function isInRange(currentTick, tickLower, tickUpper) {
    // A position is in range if the current tick is >= tickLower AND < tickUpper
    return currentTick >= tickLower && currentTick < tickUpper;
    // Note: tickUpper is exclusive (boundary condition)
}
```

### Tick to price (for display)
```js
function tickToPrice(tick, decimals0, decimals1) {
    const rawPrice = Math.pow(1.0001, tick);
    return rawPrice * (10 ** decimals0) / (10 ** decimals1);
}
```

---

## 10. V3 LIQUIDITY MATH

### Token amounts from a V3 position

This is the most complex part. The formula changes depending on whether the position is in-range, below range, or above range.

```js
// All values as BigInt or high-precision float
// sqrtPriceX96: current pool price (from slot0)
// sqrtRatioA: price at tickLower (= sqrt(1.0001^tickLower) * 2^96)
// sqrtRatioB: price at tickUpper (= sqrt(1.0001^tickUpper) * 2^96)
// liquidity: from positions() or NonfungiblePositionManager.positions()

function getAmounts(sqrtPriceX96, sqrtRatioA, sqrtRatioB, liquidity) {
    let amount0 = 0n;
    let amount1 = 0n;

    if (sqrtPriceX96 <= sqrtRatioA) {
        // Position is BELOW range — 100% token0, 0% token1
        amount0 = getAmount0ForLiquidity(sqrtRatioA, sqrtRatioB, liquidity);
    } else if (sqrtPriceX96 < sqrtRatioB) {
        // Position is IN range — mix of both tokens
        amount0 = getAmount0ForLiquidity(sqrtPriceX96, sqrtRatioB, liquidity);
        amount1 = getAmount1ForLiquidity(sqrtRatioA, sqrtPriceX96, liquidity);
    } else {
        // Position is ABOVE range — 0% token0, 100% token1
        amount1 = getAmount1ForLiquidity(sqrtRatioA, sqrtRatioB, liquidity);
    }
    return { amount0, amount1 };
}

function getAmount0ForLiquidity(sqrtRatioA, sqrtRatioB, liquidity) {
    // amount0 = liquidity * (sqrtRatioB - sqrtRatioA) / (sqrtRatioA * sqrtRatioB) * 2^96
    const Q96 = 2n ** 96n;
    return (liquidity * Q96 * (sqrtRatioB - sqrtRatioA)) / sqrtRatioB / sqrtRatioA;
}

function getAmount1ForLiquidity(sqrtRatioA, sqrtRatioB, liquidity) {
    // amount1 = liquidity * (sqrtRatioB - sqrtRatioA) / 2^96
    const Q96 = 2n ** 96n;
    return (liquidity * (sqrtRatioB - sqrtRatioA)) / Q96;
}

// Convert tick to sqrtRatioX96
function tickToSqrtRatioX96(tick) {
    const price = Math.pow(1.0001, tick);
    return BigInt(Math.floor(Math.sqrt(price) * 2 ** 96));
}
```

**Why this matters for UI:** If you show position value using the wrong branch (e.g., always using in-range formula for out-of-range positions), the token amounts will be wildly wrong. The "position value" widget breaks instantly.

---

## 11. FEE TIERS & TICK SPACING

These are linked. You cannot choose them independently for a position.

| Fee Tier | Fee Value (uint24) | Tick Spacing | Pool use case |
|---|---|---|---|
| 0.01% | `100` | `1` | Stablecoin-stablecoin (USDC/DAI) |
| 0.05% | `500` | `10` | Correlated pairs (USDC/USDT, ETH/stETH) |
| 0.30% | `3000` | `60` | Standard pairs (ETH/DAI, ETH/USDC) |
| 1.00% | `10000` | `200` | Exotic/volatile pairs |

### Tick spacing rule (CRITICAL)

`tickLower` and `tickUpper` must be **integer multiples of `tickSpacing`**.

```js
function nearestUsableTick(tick, tickSpacing) {
    const rounded = Math.round(tick / tickSpacing) * tickSpacing;
    if (rounded < MIN_TICK) return rounded + tickSpacing;
    if (rounded > MAX_TICK) return rounded - tickSpacing;
    return rounded;
}
```

**If you pass ticks that aren't divisible by tickSpacing, the `mint` transaction will revert.** This is one of the most common bugs in V3 UIs when building position range selectors.

---

## 12. V3 POSITIONS

### Positions are ERC721 NFTs, not ERC20 tokens

- Every V3 LP position is a unique NFT minted by `NonfungiblePositionManager`.
- Two LPs in the same pool with the same range are still different NFTs with different `tokenId`s.
- Ownership of the NFT = ownership of the position.
- Position data is read via `NonfungiblePositionManager.positions(tokenId)`.

### What `positions(tokenId)` returns vs what the pool stores

`positions(tokenId)` in the NonfungiblePositionManager gives you a snapshot of the position at the last time it was modified. The `tokensOwed0/1` values are NOT live — they don't update on their own between contract interactions. To get live uncollected fees:

1. Simulate a `burn(tickLower, tickUpper, 0)` call (zero-amount burn), or
2. Compute fees manually using the `feeGrowthInside` formula (see Section 13), or
3. Call `burn(0)` as a static call to update `tokensOwed` and then read it.

### Token ID is global

`tokenId` is a global counter across all positions in the NonfungiblePositionManager contract. It does NOT reset per pool. It does NOT correspond to any price, tick, or fee tier.

---

## 13. V3 FEE COLLECTION FLOW

### The 3-step sequence (must be followed exactly)

```
Step 1: burn(tickLower, tickUpper, 0)   ← zero-amount burn updates feeGrowthInside in position
Step 2: positions(positionKey) read      ← tokensOwed is now up to date
Step 3: collect(recipient, tickLower, tickUpper, amount0Max, amount1Max)  ← actually transfers tokens
```

**Via NonfungiblePositionManager (recommended path):**
```
Step 1: decreaseLiquidity(tokenId, liquidityToRemove, 0, 0, deadline)
        → This updates tokensOwed but does NOT send tokens
Step 2: collect(tokenId, recipient, type(uint128).max, type(uint128).max)
        → This actually sends tokens to recipient
Step 3 (to close position entirely): burn(tokenId)
        → Only call after liquidity = 0 AND tokensOwed = 0
```

### What NOT to do

- ❌ Do NOT call `collect()` directly without a prior `burn(0)` or `decreaseLiquidity()` — `tokensOwed` will be stale and you'll collect less than you're owed.
- ❌ Do NOT call `burn(tokenId)` before collecting — you will permanently lose uncollected fees.
- ❌ Do NOT show `tokensOwed` from a stale `positions()` read as the user's real-time fees — it's a snapshot.

### Fee math for display (manual calculation)

To show live uncollected fees in a UI without calling a burn:

```js
// feeGrowthInside = feeGrowthGlobal - feeGrowthBelow(tickLower) - feeGrowthAbove(tickUpper)
// Then:
// uncollectedFees = liquidity * (feeGrowthInside_current - feeGrowthInside_last) / 2^128

function getUncollectedFees(
    liquidity,
    feeGrowthInsideCurrent,   // computed from pool state
    feeGrowthInsideLast       // from positions() read
) {
    // Subtraction must be done in uint256 (overflow-safe modular arithmetic)
    const delta = (feeGrowthInsideCurrent - feeGrowthInsideLast) & ((1n << 256n) - 1n);
    return (liquidity * delta) >> 128n;
}
```

> **Note:** `feeGrowthGlobal0X128` is a Q128.128 value that is explicitly designed to overflow `uint256`. This overflow is intentional and expected. Use modular (wrapping) subtraction when computing deltas, not regular subtraction.

---

## 14. SWAPROUTER VS SWAPROUTER02

These are two separate contracts with different addresses and different structs.

| | SwapRouter | SwapRouter02 |
|---|---|---|
| **Address (mainnet)** | `0xE592427A0AEce92De3Edee1F18E0157C05861564` | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| **`deadline` in ExactInputSingleParams** | ✅ Yes | ❌ No |
| **Supports V2 routing** | ❌ No | ✅ Yes (also has V2SwapRouter) |
| **Supports multicall** | ✅ | ✅ |

The Uniswap interface itself uses `SwapRouter02`. If you see the router address `0x68b3...`, use the `SwapRouter02` struct. If you see `0xE592...`, use the original `SwapRouter` struct.

**Path encoding for multi-hop (applies to both):**
```js
// exactInput path: tokenIn → tokenMiddle → tokenOut
// Encoded as: abi.encodePacked(tokenIn, fee1, tokenMiddle, fee2, tokenOut)
// Example: USDC → WETH → DAI through 0.05% and 0.3% pools
const path = ethers.utils.solidityPack(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [USDC, 500, WETH, 3000, DAI]
);

// exactOutput path: REVERSED order
// For exactOutput you specify tokenOut first in the path
const exactOutputPath = ethers.utils.solidityPack(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [DAI, 3000, WETH, 500, USDC]  // reversed
);
```

> **Common mistake:** `exactInput` path goes tokenIn → tokenOut. `exactOutput` path is encoded in **reverse** — tokenOut → tokenIn. Mixing this up reverts the transaction.

---

## 15. BIGINT & PRECISION RULES

### When to use BigInt (always for on-chain values)

| Value | Type | Why |
|---|---|---|
| `sqrtPriceX96` | `uint160` | Max ~1.46 × 10^48 — completely outside JS `Number` precision |
| `reserve0`, `reserve1` | `uint112` | Can exceed `Number.MAX_SAFE_INTEGER` for high-supply tokens |
| `liquidity` | `uint128` | Max ~3.4 × 10^38 |
| `feeGrowthGlobal0X128` | `uint256` | Max ~1.16 × 10^77, overflows intentionally |
| `tokensOwed` | `uint128` | Large enough to need BigInt |
| `amountIn`, `amountOut` | `uint256` | Use BigInt always |

**Never use `Number()` or `parseFloat()` on raw contract values.** Always use `BigInt()`.

```js
// Wrong — loses precision silently
const price = (sqrtPriceX96 / 2**96) ** 2;  // sqrtPriceX96 as a number loses bits

// Right — compute with BigInt, convert to float only for display
const Q96 = 2n ** 96n;
const sqrtP = sqrtPriceX96 as bigint;
const sqrtPFloat = Number(sqrtP) / Number(Q96);  // convert late, after division
const price = sqrtPFloat * sqrtPFloat;
```

### ethers.js BigNumber vs native BigInt

If using ethers v5, contract return values are `ethers.BigNumber`. Convert properly:
```js
const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString());
```
If using ethers v6, return values are already native `bigint`.

### Division rounding

On-chain Solidity integer division truncates toward zero. Replicate this in JS:
```js
// Solidity: a / b (truncates)
// JS BigInt: a / b already truncates — correct
const result = numerator / denominator; // BigInt division, correct behavior
```

---

## 16. UI DISPLAY RULES

### Price display

- **Always state the direction.** "1 ETH = X USDC" and "1 USDC = X ETH" are both valid, but the UI must clearly show which direction it is. A toggle is standard.
- **Handle out-of-range positions.** An out-of-range V3 position holds 100% of one token. Its "price" still exists (the pool price), but the position's composition is 100% one-sided. Do not display it as if it's still earning fees symmetrically.
- **Show tick-based prices as prices, not ticks.** Convert `tickLower` and `tickUpper` to human prices before displaying. Showing raw tick numbers to users is a UX failure.
- **V3 price from tick vs sqrtPriceX96:** For current price display, decode from `sqrtPriceX96`. For range boundaries, use `tickToPrice(tickLower)` and `tickToPrice(tickUpper)`.

### Liquidity / position value display

- **Never show raw liquidity as "your share."** V3 `liquidity` is not a share of the pool. It's a mathematical constant (sqrt of the product of token amounts within the range). Display it only as a technical detail.
- **Show token amounts instead.** Use `getAmounts()` (Section 10) to display the position as "X token0 + Y token1."
- **Show total USD value** by multiplying token amounts by their USD prices.
- **Show fee APR separately** from impermanent loss. They are independent concepts.

### Fees display

- **Uncollected fees from `tokensOwed` may be stale.** Note this in the UI or trigger a refresh.
- **Do NOT conflate fees with liquidity.** `decreaseLiquidity` returns principal. `collect` returns fees. They go through separate accounting.

### Transaction feedback

- After a `decreaseLiquidity` transaction confirms, do NOT show the user "tokens received." The tokens are not received yet — they are sitting in `tokensOwed`. Show a prompt to call `collect()`.
- Show `amount0` and `amount1` from `collect()` event receipts, not from `decreaseLiquidity` event receipts.

---

## 17. CONTRACT ADDRESSES (ETHEREUM MAINNET)

### V2 Core
| Contract | Address |
|---|---|
| UniswapV2Factory | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` |
| UniswapV2Router02 | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` |

### V3 Core
| Contract | Address |
|---|---|
| UniswapV3Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| WETH9 | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

### V3 Periphery
| Contract | Address |
|---|---|
| SwapRouter (original) | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |
| SwapRouter02 (current) | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| NonfungiblePositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Quoter (V1, deprecated) | `0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6` |
| UniversalRouter | `0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD` |

---

## 18. BANNED PATTERNS

These are the exact patterns that cause broken UIs and wrong calculations. They are forbidden.

### Math bans

- ❌ `const price = (sqrtPriceX96 / 2**96) ** 2` with sqrtPriceX96 as a `number` — precision loss
- ❌ Using `tick` from `slot0` as the price for display — it lags sqrtPriceX96
- ❌ Using the in-range formula for out-of-range positions
- ❌ Regular arithmetic subtraction on `feeGrowthGlobal` — it overflows uint256 intentionally, requires wrapping subtraction
- ❌ Treating `liquidity` as a percentage or share of pool
- ❌ Using `reserve0 / reserve1` directly as price without decimal adjustment
- ❌ Using `Number()` on `uint256` or `uint160` values from contracts

### Contract call bans

- ❌ Calling `pool.swap()` directly without the callback — it will revert
- ❌ Calling `pool.mint()` directly without implementing `uniswapV3MintCallback` — it will revert
- ❌ Calling `burn(tokenId)` on NonfungiblePositionManager before removing liquidity and collecting fees
- ❌ Calling `collect()` without a prior `burn(0)` or `decreaseLiquidity()` — fees will be stale
- ❌ Using `Quoter` (V1) — it is deprecated. Use `QuoterV2`.
- ❌ Treating `Quoter`/`QuoterV2` calls as `view` functions — they are not, they simulate state changes. Use `callStatic` in ethers.js.

### Struct bans

- ❌ Using `SwapRouter`'s `ExactInputSingleParams` (with `deadline`) with the `SwapRouter02` address
- ❌ Passing ticks not divisible by `tickSpacing` to `mint()` or `increaseLiquidity()`
- ❌ Passing `token0`/`token1` in unsorted order to `MintParams`

### UI bans

- ❌ Showing raw `liquidity` as the position's value or share
- ❌ Showing `tokensOwed` from a stale `positions()` read as "real-time fees"
- ❌ Showing `decreaseLiquidity` output as "tokens received" before `collect()` is called
- ❌ Showing ticks directly to users instead of human-readable prices
- ❌ Not indicating price direction (which token is the denominator)

---

## 19. PRE-TASK CHECKLIST

Before making any change to Uniswap V2/V3 code, run through this list:

**Context**
- [ ] Which version is this codebase using — V2, V3, or both?
- [ ] Where is the pool address coming from? For V3: does it use the right fee tier?
- [ ] What is token0 and token1 ordering in this pool?
- [ ] What are the decimals for each token?

**For V3 specifically**
- [ ] Is `sqrtPriceX96` being decoded correctly with BigInt math?
- [ ] Is decimal adjustment applied at the right step?
- [ ] Is the position in-range, below range, or above range? Is the correct amount formula being used?
- [ ] Are `tickLower`/`tickUpper` divisible by `tickSpacing` for this fee tier?
- [ ] Is fee collection following the 3-step sequence?
- [ ] Which router is being used? SwapRouter or SwapRouter02? Is the struct matching?

**Before changing any formula or calculation**
- [ ] Have I traced what downstream UI elements consume this value?
- [ ] Have I confirmed the change doesn't flip token0/token1 ordering?
- [ ] Have I verified the decimal adjustment is consistent throughout?
- [ ] Have I confirmed BigInt is used end-to-end, not just at the point of calculation?

**Before changing any contract call sequence**
- [ ] Does this change the order of `burn` / `collect` / `decreaseLiquidity`?
- [ ] Will any tokens be stranded (computed but not transferred)?
- [ ] Is there a callback required that I need to implement?

---

*This document is sourced from the UniswapV3Pool, NonfungiblePositionManager, SwapRouter, and SwapRouter02 contract code and official Uniswap documentation. Follow it strictly — V3 math is unforgiving.*
