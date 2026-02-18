import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { X, AlertTriangle } from "lucide-react";

interface SwapSettingsProps {
  open: boolean;
  onClose: () => void;
  slippage: number;
  onSlippageChange: (value: number) => void;
  deadline: number;
  onDeadlineChange: (value: number) => void;
  recipientAddress: string;
  onRecipientAddressChange: (value: string) => void;
  quoteRefreshInterval?: number;
  onQuoteRefreshIntervalChange?: (value: number) => void;
  // V2/V3 protocol settings
  v2Enabled: boolean;
  v3Enabled: boolean;
  onV2EnabledChange: (enabled: boolean) => void;
  onV3EnabledChange: (enabled: boolean) => void;
  // Add these props for max balance functionality
  maxBalance?: number;
  onMaxBalanceClick?: () => void;
}

export function SwapSettings({
  open,
  onClose,
  slippage,
  onSlippageChange,
  deadline,
  onDeadlineChange,
  recipientAddress,
  onRecipientAddressChange,
  quoteRefreshInterval = 30,
  onQuoteRefreshIntervalChange,
  v2Enabled,
  v3Enabled,
  onV2EnabledChange,
  onV3EnabledChange,
  maxBalance, // Destructure maxBalance
  onMaxBalanceClick, // Destructure onMaxBalanceClick
}: SwapSettingsProps) {
  const [customSlippage, setCustomSlippage] = useState(slippage.toString());
  const [customDeadline, setCustomDeadline] = useState(deadline.toString());
  const [customRefreshInterval, setCustomRefreshInterval] = useState(quoteRefreshInterval.toString());

  const presetSlippages = [0.1, 0.5, 1.0];
  // Removed dangerous "Auto" mode that set slippage to 100% (minAmountOut = 0)
  // This was a sandwich attack vulnerability

  const bothDisabled = !v2Enabled && !v3Enabled;

  const handleSlippageChange = (value: string) => {
    setCustomSlippage(value);
    const numValue = parseFloat(value);
    if (!isNaN(numValue) && numValue >= 0 && numValue <= 50) {
      onSlippageChange(numValue);
    }
  };

  const handleDeadlineChange = (value: string) => {
    setCustomDeadline(value);
    const numValue = parseInt(value);
    if (!isNaN(numValue) && numValue > 0) {
      onDeadlineChange(numValue);
    }
  };

  const handleRefreshIntervalChange = (value: string) => {
    setCustomRefreshInterval(value);
    const numValue = parseInt(value);
    if (!isNaN(numValue) && numValue >= 5 && onQuoteRefreshIntervalChange) {
      onQuoteRefreshIntervalChange(numValue);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md bg-slate-900 border-slate-700">
        {/* Updated DialogHeader for better close button visibility */}
        <DialogHeader>
          <DialogTitle className="text-white">Swap Settings</DialogTitle>
          <DialogDescription className="text-slate-300">Customize your swap preferences</DialogDescription>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4 h-8 w-8 hover:bg-slate-700 text-slate-100 hover:text-white"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          {/* Protocol Settings - V2/V3 */}
          <div className="space-y-3 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
            <h3 className="text-sm font-semibold text-white mb-3">Protocol Routing</h3>
            
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">Achswap V2</Label>
                <p className="text-xs text-slate-400">Classic constant product AMM</p>
              </div>
              <Switch
                checked={v2Enabled}
                onCheckedChange={onV2EnabledChange}
                disabled={v2Enabled && !v3Enabled}
              />
            </div>
            
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">Achswap V3</Label>
                <p className="text-xs text-slate-400">Concentrated liquidity pools</p>
              </div>
              <Switch
                checked={v3Enabled}
                onCheckedChange={onV3EnabledChange}
                disabled={v3Enabled && !v2Enabled}
              />
            </div>

            {bothDisabled && (
              <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>At least one protocol must be enabled</span>
              </div>
            )}

            {v2Enabled && v3Enabled && (
              <div className="p-2 bg-blue-500/10 border border-blue-500/20 rounded text-xs text-blue-400">
                Smart routing enabled: Best price will be automatically selected
              </div>
            )}
          </div>

          {/* Slippage Tolerance */}
          <div className="space-y-3">
            <Label className="text-sm font-medium text-white">Slippage Tolerance (%)</Label>
            <div className="flex gap-2">
              {presetSlippages.map((preset) => (
                <Button
                  key={preset}
                  size="sm"
                  variant={slippage === preset ? "default" : "secondary"}
                  onClick={() => {
                    onSlippageChange(preset);
                    setCustomSlippage(preset.toString());
                  }}
                  className="flex-1"
                >
                  {preset}%
                </Button>
              ))}
            </div>
            <div className="relative">
              <Input
                type="number"
                placeholder="Custom"
                value={customSlippage}
                onChange={(e) => handleSlippageChange(e.target.value)}
                className="pr-8 bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
                min="0"
                max="50"
                step="0.1"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                %
              </span>
            </div>
            {slippage > 5 && (
              <p className="text-xs text-orange-400 bg-orange-500/10 p-2 rounded border border-orange-500/20">
                High slippage tolerance. Your transaction may be frontrun.
              </p>
            )}
            {slippage === 0 && (
              <p className="text-xs text-red-400 bg-red-500/10 p-2 rounded border border-red-500/20">
                Warning: 0% slippage may cause transaction failures due to price movements.
              </p>
            )}
          </div>

          {/* Transaction Deadline */}
          <div className="space-y-3">
            <Label className="text-sm font-medium text-white">Transaction Deadline (minutes)</Label>
            <div className="relative">
              <Input
                type="number"
                placeholder="20"
                value={customDeadline}
                onChange={(e) => handleDeadlineChange(e.target.value)}
                className="pr-16 bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
                min="1"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                minutes
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Your transaction will revert if pending for more than this time.
            </p>
          </div>

          {/* Quote Refresh Interval */}
          <div className="space-y-3">
            <Label className="text-sm font-medium text-white">Quote Refresh Interval (seconds)</Label>
            <div className="relative">
              <Input
                type="number"
                placeholder="30"
                value={customRefreshInterval}
                onChange={(e) => handleRefreshIntervalChange(e.target.value)}
                className="pr-16 bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
                min="5"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                seconds
              </span>
            </div>
            <p className="text-xs text-slate-400">
              How often to refresh swap quotes automatically.
            </p>
          </div>

          {/* Send to Different Wallet */}
          <div className="space-y-3">
            <Label className="text-sm font-medium text-white">Recipient Address (Optional)</Label>
            <Input
              type="text"
              placeholder="0x... (leave empty to send to your wallet)"
              value={recipientAddress}
              onChange={(e) => onRecipientAddressChange(e.target.value)}
              className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
            />
            <p className="text-xs text-slate-400">
              Send tokens to a different address after swap.
            </p>
          </div>

          {/* Max Balance Button - Added */}
          {maxBalance !== undefined && onMaxBalanceClick && (
            <div className="space-y-3">
              <Label className="text-sm font-medium text-white">Maximum Available Balance</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={maxBalance.toString()} // Display max balance
                  readOnly
                  className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-400 flex-grow"
                />
                <Button onClick={onMaxBalanceClick} className="bg-blue-600 hover:bg-blue-700 text-white">
                  MAX
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
