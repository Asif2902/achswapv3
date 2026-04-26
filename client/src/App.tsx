import { useEffect, useState } from "react";
import { Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { queryClient } from "./lib/queryClient";
import { config } from "./lib/wagmi";
import { bootstrapAppReadiness, hasCompletedAppBootstrap, type AppBootstrapPhase } from "./lib/app-bootstrap";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Header } from "@/components/Header";
import Swap from "@/pages/Swap";
import AddLiquidity from "@/pages/AddLiquidity";
import RemoveLiquidity from "@/pages/RemoveLiquidity";
import Pools from "@/pages/Pools";
import Bridge from "@/pages/Bridge";
import LaunchToken from "@/pages/LaunchToken";
import NotFound from "@/pages/not-found";

import "@rainbow-me/rainbowkit/styles.css";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Swap} />
      <Route path="/add-liquidity" component={AddLiquidity} />
      <Route path="/remove-liquidity" component={RemoveLiquidity} />
      <Route path="/analytics" component={Pools} />
      <Route path="/bridge" component={Bridge} />
      <Route path="/launch" component={LaunchToken} />
      <Route component={NotFound} />
    </Switch>
  );
}

const BOOTSTRAP_MIN_VISIBLE_MS = 420;

function AppBootstrapOverlay({ phase, visible }: { phase: AppBootstrapPhase; visible: boolean }) {
  const copy: Record<AppBootstrapPhase, { kicker: string; title: string }> = {
    rpc: {
      kicker: "RPC failover ready",
      title: "Checking the fastest live endpoint",
    },
    community: {
      kicker: "Warm cache",
      title: "Loading community tokens and swap data",
    },
    ready: {
      kicker: "Ready",
      title: "Preparing your first screen",
    },
  };

  const activeIndex = phase === "rpc" ? 0 : phase === "community" ? 1 : 2;

  return (
    <div
      aria-hidden={!visible}
      className="fixed inset-0 z-[120] flex items-center justify-center px-6 transition-all duration-300"
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        background:
          "radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 38%), rgba(5,8,13,0.92)",
        backdropFilter: visible ? "blur(18px)" : "blur(0px)",
      }}
    >
      <div
        className="w-full max-w-sm rounded-[28px] border px-6 py-7"
        style={{
          background:
            "linear-gradient(155deg, rgba(16,21,31,0.96) 0%, rgba(9,13,20,0.98) 100%)",
          borderColor: "rgba(148,163,184,0.14)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
        }}
      >
        <div className="relative mb-6 h-24 overflow-hidden rounded-[22px] border border-white/8 bg-white/[0.03]">
          <div
            className="absolute inset-x-5 top-4 h-2 rounded-full"
            style={{ background: "rgba(96,165,250,0.12)" }}
          />
          <div
            className="absolute left-5 top-4 h-2 rounded-full transition-all duration-300"
            style={{
              width: `${(activeIndex + 1) * 33.33}%`,
              background: "linear-gradient(90deg, #60a5fa 0%, #38bdf8 100%)",
              boxShadow: "0 0 18px rgba(56,189,248,0.28)",
            }}
          />
          <div className="absolute inset-x-5 bottom-4 flex items-end gap-2">
            {[0, 1, 2, 3, 4].map((bar) => (
              <div
                key={bar}
                className="flex-1 rounded-full"
                style={{
                  height: `${28 + ((bar + activeIndex) % 3) * 14}px`,
                  background:
                    bar <= activeIndex + 1
                      ? "linear-gradient(180deg, rgba(96,165,250,0.95) 0%, rgba(34,211,238,0.58) 100%)"
                      : "rgba(255,255,255,0.06)",
                  animation: "bootPulse 1.15s ease-in-out infinite",
                  animationDelay: `${bar * 120}ms`,
                }}
              />
            ))}
          </div>
        </div>

        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-300/80">
          {copy[phase].kicker}
        </p>
        <h2 className="text-xl font-semibold tracking-tight text-white">
          {copy[phase].title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-white/45">
          Backup RPC and token caches are being primed so balances, liquidity views, and swap inputs open warm.
        </p>

        <div className="mt-6 flex gap-2">
          {[0, 1, 2].map((step) => (
            <span
              key={step}
              className="h-1.5 flex-1 rounded-full transition-all duration-300"
              style={{
                background:
                  step <= activeIndex
                    ? "linear-gradient(90deg, rgba(96,165,250,0.95) 0%, rgba(34,211,238,0.78) 100%)"
                    : "rgba(255,255,255,0.08)",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function App() {
  const initiallyVisible = !hasCompletedAppBootstrap();
  const [bootPhase, setBootPhase] = useState<AppBootstrapPhase>("rpc");
  const [bootVisible, setBootVisible] = useState(initiallyVisible);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    let hideTimer: number | null = null;

    const { promise, unsubscribe } = bootstrapAppReadiness((phase) => {
      if (!cancelled) {
        setBootPhase(phase);
      }
    });

    promise.finally(() => {
      if (cancelled) return;

      const elapsed = Date.now() - startedAt;
      const remainingMinVisible = initiallyVisible
        ? Math.max(0, BOOTSTRAP_MIN_VISIBLE_MS - elapsed)
        : 0;

      hideTimer = window.setTimeout(() => {
        if (!cancelled) {
          setBootVisible(false);
        }
      }, remainingMinVisible + (initiallyVisible ? 160 : 0));
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
      }
    };
  }, [initiallyVisible]);

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider 
          theme={darkTheme({
            accentColor: '#3b82f6',
            accentColorForeground: 'white',
            borderRadius: 'medium',
            overlayBlur: 'small',
          })}
        >
          <TooltipProvider>
            <div className="dark min-h-screen bg-background">
              <Header />
              <main className="pb-12 fade-in">
                <Router />
              </main>
              <AppBootstrapOverlay phase={bootPhase} visible={bootVisible} />
            </div>
            <Toaster />
            <style>{`
              @keyframes bootPulse {
                0%, 100% { transform: translateY(0); opacity: 0.82; }
                50% { transform: translateY(-3px); opacity: 1; }
              }
            `}</style>
          </TooltipProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
