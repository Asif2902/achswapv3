import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RemoveLiquidityV2 } from "@/components/RemoveLiquidityV2";
import { RemoveLiquidityV3 } from "@/components/RemoveLiquidityV3";

export default function RemoveLiquidity() {
  return (
    <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8 max-w-2xl">
      <Card className="bg-slate-900/50 border-slate-700">
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-xl sm:text-2xl md:text-3xl font-bold text-center">
            Remove Liquidity
          </CardTitle>
          <p className="text-center text-slate-400 text-xs sm:text-sm mt-2">
            Withdraw your liquidity from pools
          </p>
        </CardHeader>
        <CardContent className="p-3 sm:p-6">
          <Tabs defaultValue="v2" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-4 sm:mb-6 h-9 sm:h-10">
              <TabsTrigger value="v2" className="text-xs sm:text-sm">V2</TabsTrigger>
              <TabsTrigger value="v3" className="text-xs sm:text-sm">V3 / Collect Fees</TabsTrigger>
            </TabsList>

            <TabsContent value="v2">
              <RemoveLiquidityV2 />
            </TabsContent>

            <TabsContent value="v3">
              <RemoveLiquidityV3 />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
