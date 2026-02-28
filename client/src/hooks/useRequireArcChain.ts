import { useState, useCallback } from "react";
import { useAccount, useChainId } from "wagmi";

const ARC_CHAIN_ID = 5042002;
const ARC_CHAIN_HEX = "0x" + ARC_CHAIN_ID.toString(16);

/**
 * Returns whether the connected wallet is on the wrong chain,
 * plus a `switchToArc()` function the UI can call from a button.
 *
 * Does NOT auto-fire any wallet popups — the user decides when to switch.
 */
export function useRequireArcChain() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const [isSwitching, setIsSwitching] = useState(false);

  const isWrongChain = isConnected && chainId !== ARC_CHAIN_ID;

  const switchToArc = useCallback(async () => {
    if (!window.ethereum) return;
    setIsSwitching(true);
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARC_CHAIN_HEX }],
      });
    } catch (err: any) {
      // 4902 = chain not added to wallet yet
      if (err.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: ARC_CHAIN_HEX,
              chainName: "ARC Testnet",
              nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
              rpcUrls: ["https://rpc.testnet.arc.network"],
              blockExplorerUrls: ["https://testnet.arcscan.app"],
            }],
          });
        } catch {
          // User rejected — nothing more we can do
        }
      }
    } finally {
      setIsSwitching(false);
    }
  }, []);

  return { isWrongChain, isSwitching, switchToArc };
}
