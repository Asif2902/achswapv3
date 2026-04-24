import { preloadCommunityTokens } from "@/data/tokens";
import { warmRpcProvider } from "@/lib/config";

const APP_BOOTSTRAP_SESSION_KEY = "achswap_app_bootstrap_v1";
const ARC_TESTNET_CHAIN_ID = 5042002;
const BOOTSTRAP_RPC_TIMEOUT_MS = 900;
const BACKGROUND_COMMUNITY_PRELOAD_DELAY_MS = 1200;

export type AppBootstrapPhase = "rpc" | "community" | "ready";

let bootstrapPromise: Promise<void> | null = null;
let backgroundWarmScheduled = false;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function scheduleCommunityWarmup() {
  if (backgroundWarmScheduled || typeof window === "undefined") return;
  backgroundWarmScheduled = true;

  const run = () => {
    void preloadCommunityTokens(ARC_TESTNET_CHAIN_ID).catch(() => undefined);
  };

  const requestIdle = (window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;

  if (typeof requestIdle === "function") {
    window.setTimeout(() => {
      requestIdle(run, { timeout: 1500 });
    }, BACKGROUND_COMMUNITY_PRELOAD_DELAY_MS);
    return;
  }

  window.setTimeout(run, BACKGROUND_COMMUNITY_PRELOAD_DELAY_MS);
}

export async function bootstrapAppReadiness(
  onPhase?: (phase: AppBootstrapPhase) => void,
): Promise<void> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    onPhase?.("rpc");
    await Promise.race([
      warmRpcProvider(ARC_TESTNET_CHAIN_ID).catch(() => undefined),
      sleep(BOOTSTRAP_RPC_TIMEOUT_MS),
    ]);

    onPhase?.("ready");
    markAppBootstrapComplete();
    scheduleCommunityWarmup();
  })();

  return bootstrapPromise;
}
