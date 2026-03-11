import React from "react";
import { Card } from "@/components/ui/card";
import { Activity } from "lucide-react";

export default function Pools() {
  return (
    <div className="container mx-auto max-w-7xl pt-24 pb-20 px-4 min-h-[calc(100vh-4rem)] flex flex-col pt-0 sm:pt-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2 bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
            Analytics
          </h1>
          <p className="text-muted-foreground text-sm max-w-xl">
            View detailed analytics, volume, and TVL across all liquidity pools.
          </p>
        </div>
      </div>

      <Card className="flex-1 flex flex-col items-center justify-center p-12 text-center min-h-[400px] border-border/40 shadow-xl bg-card/60 backdrop-blur-sm">
        <div className="h-20 w-20 bg-primary/10 rounded-full flex items-center justify-center mb-6">
          <Activity className="h-10 w-10 text-primary" />
        </div>
        <h2 className="text-2xl font-bold mb-3">Coming Soon</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          We are currently working on a brand new analytics dashboard that will provide deeper insights into all V2 and V3 pools.
        </p>
      </Card>
    </div>
  );
}
