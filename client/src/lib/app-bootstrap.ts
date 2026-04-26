import { preloadCommunityTokens } from "@/data/tokens";
import { ARC_TESTNET_CHAIN_ID, warmRpcProvider } from "@/lib/config";

const APP_BOOTSTRAP_SESSION_KEY = "achswap_app_bootstrap_v1";
const BOOTSTRAP_RPC_TIMEOUT_MS = 900;
const COMMUNITY_PRELOAD_START_DELAY_MS = 60;

export type AppBootstrapPhase = "rpc" | "community" | "ready";

let bootstrapPromise: Promise<void> | null = null;
let currentPhase: AppBootstrapPhase | null = null;
const phaseListeners = new Set<(phase: AppBootstrapPhase) => void>();

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

function notifyPhaseListener(
  callback: (phase: AppBootstrapPhase) => void,
  phase: AppBootstrapPhase,
) {
  try {
    callback(phase);
  } catch (error) {
    console.error("[app-bootstrap] phase listener failed", error);
  }
}

function setPhase(phase: AppBootstrapPhase) {
  currentPhase = phase;
  for (const callback of phaseListeners) {
    notifyPhaseListener(callback, phase);
  }
}

export function bootstrapAppReadiness(
  onPhase?: (phase: AppBootstrapPhase) => void,
): { promise: Promise<void>, unsubscribe: () => void } {
  const unsubscribe = () => {
    if (onPhase) {
      phaseListeners.delete(onPhase);
    }
  };

  // Register listener if provided
  if (onPhase) {
    phaseListeners.add(onPhase);
    // Immediately notify if phase is already set
    if (currentPhase) {
      notifyPhaseListener(onPhase, currentPhase);
    }
  }

  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      setPhase("rpc");
      const communityPromise = sleep(COMMUNITY_PRELOAD_START_DELAY_MS)
        .then(() => preloadCommunityTokens(ARC_TESTNET_CHAIN_ID))
        .catch((error) => {
          console.error("[app-bootstrap] community preload failed", error);
        });
      const warmRpcPromise = warmRpcProvider(ARC_TESTNET_CHAIN_ID).catch((error) => {
        console.error("[app-bootstrap] RPC warmup failed", error);
      });

      try {
        await Promise.race([
          warmRpcPromise,
          sleep(BOOTSTRAP_RPC_TIMEOUT_MS),
        ]);

        setPhase("community");
        await communityPromise;
      } catch (error) {
        console.error("[app-bootstrap] bootstrap readiness failed", error);
      } finally {
        setPhase("ready");
        markAppBootstrapComplete();
      }
    })();
  }

  return {
    promise: bootstrapPromise,
    unsubscribe,
  };
}
