# Solidity Issues to Fix

## Issue 1: V3 multi-hop reads tokenIn from params instead of normalized tokenIn

**Location:** `_swapV3Multi` function

**Problem:** The V3 multi-hop swap reads its input token from `seg.params` (path) instead of using the normalized `tokenIn` passed from execute/executeSplit. This can cause approvals/spends of a different token.

**Fix:** Update `_swapV3Multi` to accept/use the `tokenIn` passed by the caller, or at minimum validate that the first token encoded in `seg.params` equals the provided `tokenIn`. Stop reading/deriving the input token from `seg.params` for approvals/transfers.

---

## Issue 2: execute() doesn't verify segment.amountIn == totalAmountIn

**Location:** `execute` function (around line 145-163)

**Problem:** The execute function pulls `totalAmountIn` via Permit2 but uses `segment.amountIn` when executing the route. This allows leftover tokens.

**Fix:** Add a check in `execute` to require `segment.amountIn == totalAmountIn` and revert if they differ (e.g., `revert MismatchedAmounts()` or with a clear error message) before calling `_pullViaPermit2/_executeSegment`.

---

## Issue 3: executeSplit() doesn't verify all segments have same output token

**Location:** `executeSplit` function (around line 188-195)

**Problem:** The code assumes all split segments end in the same output token but doesn't verify it.

**Fix:** Call `_getTokenOut` for each segment and compare to the initial `tokenOut` before summing amounts from `_executeSegment`. If any segment's output token differs, revert the transaction so mixed-output routes are rejected.

---

## Issue 4: Similar V3 path handling

**Location:** Any other V3 handler functions (similar to the one around lines 289-317)

**Problem:** Same as Issue 1 - V3 path handling code reads from seg.params instead of using provided tokenIn.

**Fix:** Apply the same fix as Issue 1 - either take `tokenIn` as an explicit parameter or assert `path[0] == tokenIn` before doing any approve/transfer/spend logic.
