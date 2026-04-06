import { lazy, Suspense } from "react";
import { Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { queryClient } from "./lib/queryClient";
import { config } from "./lib/wagmi";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Header } from "@/components/Header";

const Swap = lazy(() => import("@/pages/Swap"));
const AddLiquidity = lazy(() => import("@/pages/AddLiquidity"));
const RemoveLiquidity = lazy(() => import("@/pages/RemoveLiquidity"));
const Pools = lazy(() => import("@/pages/Pools"));
const Bridge = lazy(() => import("@/pages/Bridge"));
const LaunchToken = lazy(() => import("@/pages/LaunchToken"));
const NotFound = lazy(() => import("@/pages/not-found"));

import "@rainbow-me/rainbowkit/styles.css";

function Router() {
  return (
    <Suspense fallback={<RouteFallback />}> 
      <Switch>
        <Route path="/" component={Swap} />
        <Route path="/add-liquidity" component={AddLiquidity} />
        <Route path="/remove-liquidity" component={RemoveLiquidity} />
        <Route path="/analytics" component={Pools} />
        <Route path="/bridge" component={Bridge} />
        <Route path="/launch" component={LaunchToken} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function RouteFallback() {
  return (
    <div className="w-full max-w-md mx-auto px-4 py-10">
      <div className="rounded-2xl border border-white/10 bg-card/80 p-4">
        <div className="h-4 w-32 rounded bg-white/10 animate-pulse" />
        <div className="mt-3 h-3 w-full rounded bg-white/5 animate-pulse" />
        <div className="mt-2 h-3 w-5/6 rounded bg-white/5 animate-pulse" />
      </div>
    </div>
  );
}

function App() {
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
            </div>
            <Toaster />
          </TooltipProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
