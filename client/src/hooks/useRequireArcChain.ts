import { useEffect, useRef } from "react";
import { useAccount, useChainId } from "wagmi";

const ARC_CHAIN_ID = 5042002;
const ARC_CHAIN_HEX = "0x" + ARC_CHAIN_ID.toString(16);

/**
 * Auto-fires wallet_switchEthereumChain when the connected wallet
 * is on a chain other than Arc Testnet (5042002).
 *
 * Fires only once per "wrong chain" session — resets if user
 * switches away again after having been on Arc.
 */
export function useRequireArcChain() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const hasFiredRef = useRef(false);
  const lastChainRef = useRef<number | undefined>(undefined);

  const isWrongChain = isConnected && chainId !== ARC_CHAIN_ID;

  useEffect(() => {
    // Reset the "already fired" flag if chain changes
    if (lastChainRef.current !== chainId) {
      lastChainRef.current = chainId;
      hasFiredRef.current = false;
    }

    if (!isWrongChain || hasFiredRef.current) return;
    if (!window.ethereum) return;

    hasFiredRef.current = true;

    (async () => {
      try {
        await window.ethereum!.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ARC_CHAIN_HEX }],
        });
      } catch (err: any) {
        // 4902 = chain not added to wallet yet
        if (err.code === 4902) {
          try {
            await window.ethereum!.request({
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
      }
    })();
  }, [isWrongChain, chainId]);

  return { isWrongChain };
}
