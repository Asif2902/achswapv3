import { preloadCommunityTokens } from "@/data/tokens";
import { warmRpcProvider } from "@/lib/config";

const APP_BOOTSTRAP_SESSION_KEY = "achswap_app_bootstrap_v1";
const ARC_TESTNET_CHAIN_ID = 5042002;

export type AppBootstrapPhase = "rpc" | "community" | "ready";

let bootstrapPromise: Promise<void> | null = null;

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && !!window.sessionStorage;
}

export function hasCompletedAppBootstrap(): boolean {
  if (!canUseSessionStorage()) return false;
  return window.sessionStorage.getItem(APP_BOOTSTRAP_SESSION_KEY) === "1";
}

function markAppBootstrapComplete() {
  if (!canUseSessionStorage()) return;
  try {
    window.sessionStorage.setItem(APP_BOOTSTRAP_SESSION_KEY, "1");
  } catch {
    // Ignore session storage issues.
  }
}

export async function bootstrapAppReadiness(
  onPhase?: (phase: AppBootstrapPhase) => void,
): Promise<void> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    onPhase?.("rpc");
    await warmRpcProvider(ARC_TESTNET_CHAIN_ID).catch(() => undefined);

    onPhase?.("community");
    await preloadCommunityTokens(ARC_TESTNET_CHAIN_ID).catch(() => undefined);

    onPhase?.("ready");
    markAppBootstrapComplete();
  })();

  return bootstrapPromise;
}
