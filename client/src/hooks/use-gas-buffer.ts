import { useMemo } from "react";

const GAS_BUFFER_PERCENT = 20;

export function useGasBuffer(balanceWei: bigint): bigint {
  return useMemo(() => {
    if (balanceWei === 0n || balanceWei === undefined) return 0n;
    return (balanceWei * BigInt(100 - GAS_BUFFER_PERCENT)) / 100n;
  }, [balanceWei]);
}

export function getGasBufferAmount(balanceWei: bigint): bigint {
  if (balanceWei === 0n || balanceWei === undefined) return 0n;
  return (balanceWei * BigInt(100 - GAS_BUFFER_PERCENT)) / 100n;
}
