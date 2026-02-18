import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowDownUp } from "lucide-react";
import { useAccount, useBalance } from "wagmi";
import { formatUnits, parseUnits } from "ethers";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";

interface WrapUnwrapModalProps {
  open: boolean;
  onClose: () => void;
  usdcToken: Token;
  wusdcToken: Token;
  onWrap?: (amount: string) => Promise<void>;
  onUnwrap?: (amount: string) => Promise<void>;
}

export function WrapUnwrapModal({ 
  open, 
  onClose, 
  usdcToken, 
  wusdcToken,
  onWrap,
  onUnwrap 
}: WrapUnwrapModalProps) {
  const [wrapAmount, setWrapAmount] = useState("");
  const [unwrapAmount, setUnwrapAmount] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const { address } = useAccount();
  const { toast } = useToast();

  // USDC is native token, wUSDC is ERC20
  const { data: usdcBalance } = useBalance({
    address: address as `0x${string}` | undefined,
  });

  const { data: wusdcBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    token: wusdcToken.address as `0x${string}`,
  });

  const handleWrap = async () => {
    if (!onWrap || !wrapAmount || parseFloat(wrapAmount) <= 0) return;
    
    setIsProcessing(true);
    try {
      await onWrap(wrapAmount);
      setWrapAmount("");
      toast({
        title: "Success",
        description: `Wrapped ${wrapAmount} USDC to wUSDC`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to wrap tokens",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnwrap = async () => {
    if (!onUnwrap || !unwrapAmount || parseFloat(unwrapAmount) <= 0) return;
    
    setIsProcessing(true);
    try {
      await onUnwrap(unwrapAmount);
      setUnwrapAmount("");
      toast({
        title: "Success",
        description: `Unwrapped ${unwrapAmount} wUSDC to USDC`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to unwrap tokens",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const usdcBalanceFormatted = usdcBalance ? formatUnits(usdcBalance.value, usdcBalance.decimals) : "0";
  const wusdcBalanceFormatted = wusdcBalance ? formatUnits(wusdcBalance.value, wusdcBalance.decimals) : "0";

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">Wrap / Unwrap USDC</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="wrap" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="wrap" data-testid="tab-wrap">Wrap</TabsTrigger>
            <TabsTrigger value="unwrap" data-testid="tab-unwrap">Unwrap</TabsTrigger>
          </TabsList>

          <TabsContent value="wrap" className="space-y-4 mt-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">From USDC</label>
                <span className="text-sm text-muted-foreground">
                  Balance: {parseFloat(usdcBalanceFormatted).toFixed(6)}
                </span>
              </div>
              <div className="relative">
                <Input
                  data-testid="input-wrap-amount"
                  type="number"
                  placeholder="0.00"
                  value={wrapAmount}
                  onChange={(e) => setWrapAmount(e.target.value)}
                  className="text-2xl font-semibold h-16 pr-20"
                />
                <Button
                  data-testid="button-wrap-max"
                  size="sm"
                  variant="secondary"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  onClick={() => setWrapAmount(usdcBalanceFormatted)}
                >
                  MAX
                </Button>
              </div>
            </div>

            <div className="flex justify-center">
              <div className="bg-muted rounded-full p-2">
                <ArrowDownUp className="h-4 w-4" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">To wUSDC</label>
              <div className="bg-muted rounded-md p-4">
                <p className="text-2xl font-semibold tabular-nums">
                  {wrapAmount || "0.00"}
                </p>
              </div>
            </div>

            <Button
              data-testid="button-confirm-wrap"
              onClick={handleWrap}
              disabled={!wrapAmount || parseFloat(wrapAmount) <= 0 || isProcessing || !address}
              className="w-full h-12 text-base"
            >
              {isProcessing ? "Wrapping..." : "Wrap USDC"}
            </Button>
          </TabsContent>

          <TabsContent value="unwrap" className="space-y-4 mt-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">From wUSDC</label>
                <span className="text-sm text-muted-foreground">
                  Balance: {parseFloat(wusdcBalanceFormatted).toFixed(6)}
                </span>
              </div>
              <div className="relative">
                <Input
                  data-testid="input-unwrap-amount"
                  type="number"
                  placeholder="0.00"
                  value={unwrapAmount}
                  onChange={(e) => setUnwrapAmount(e.target.value)}
                  className="text-2xl font-semibold h-16 pr-20"
                />
                <Button
                  data-testid="button-unwrap-max"
                  size="sm"
                  variant="secondary"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  onClick={() => setUnwrapAmount(wusdcBalanceFormatted)}
                >
                  MAX
                </Button>
              </div>
            </div>

            <div className="flex justify-center">
              <div className="bg-muted rounded-full p-2">
                <ArrowDownUp className="h-4 w-4" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">To USDC</label>
              <div className="bg-muted rounded-md p-4">
                <p className="text-2xl font-semibold tabular-nums">
                  {unwrapAmount || "0.00"}
                </p>
              </div>
            </div>

            <Button
              data-testid="button-confirm-unwrap"
              onClick={handleUnwrap}
              disabled={!unwrapAmount || parseFloat(unwrapAmount) <= 0 || isProcessing || !address}
              className="w-full h-12 text-base"
            >
              {isProcessing ? "Unwrapping..." : "Unwrap wUSDC"}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
