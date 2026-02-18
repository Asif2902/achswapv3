
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ExternalLink, ArrowRight } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Token } from "@shared/schema";
import { useEffect, useState } from "react";
import { useChainId } from "wagmi";
import { getContractsForChain } from "@/lib/contracts";

interface Transaction {
  id: string;
  fromToken: Token;
  toToken: Token;
  fromAmount: string;
  toAmount: string;
  timestamp: number;
  chainId: number;
}

interface TransactionHistoryProps {
  open: boolean;
  onClose: () => void;
}

export function TransactionHistory({ open, onClose }: TransactionHistoryProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const chainId = useChainId();

  useEffect(() => {
    if (open && chainId) {
      const storageKey = `transactions_${chainId}`;
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        setTransactions(JSON.parse(stored));
      } else {
        setTransactions([]);
      }
    }
  }, [open, chainId]);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  };

  const openExplorer = (txHash: string) => {
    const contracts = chainId ? getContractsForChain(chainId) : null;
    if (contracts) {
      window.open(`${contracts.explorer}${txHash}`, '_blank');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-md bg-slate-900 border-slate-700" hideDefaultClose>
        <DialogHeader>
          <DialogTitle className="text-xl font-bold text-white">Transaction History</DialogTitle>
        </DialogHeader>

        <ScrollArea className="h-[400px] pr-4">
          {transactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-slate-400 text-sm">No transactions yet</p>
              <p className="text-slate-500 text-xs mt-1">Your swap history will appear here</p>
            </div>
          ) : (
            <div className="space-y-3">
              {transactions.map((tx) => (
                <div 
                  key={tx.id} 
                  className="bg-slate-800 rounded-xl p-4 border border-slate-700 hover:border-primary/40 transition-all"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-slate-400">{formatTime(tx.timestamp)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-slate-400 hover:text-white hover:bg-slate-700"
                      onClick={() => openExplorer(tx.id)}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 flex-1">
                      {tx.fromToken.logoURI ? (
                        <img 
                          src={tx.fromToken.logoURI} 
                          alt={tx.fromToken.symbol} 
                          className="w-8 h-8 rounded-full" 
                          onError={(e) => {
                            e.currentTarget.src = '/img/logos/unknown-token.png';
                          }}
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-400">?</div>
                      )}
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-semibold truncate text-white">{parseFloat(tx.fromAmount).toFixed(4)} {tx.fromToken.symbol}</span>
                      </div>
                    </div>

                    <ArrowRight className="h-4 w-4 text-slate-500 flex-shrink-0" />

                    <div className="flex items-center gap-2 flex-1">
                      {tx.toToken.logoURI ? (
                        <img 
                          src={tx.toToken.logoURI} 
                          alt={tx.toToken.symbol} 
                          className="w-8 h-8 rounded-full" 
                          onError={(e) => {
                            e.currentTarget.src = '/img/logos/unknown-token.png';
                          }}
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-400">?</div>
                      )}
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-semibold truncate text-white">{parseFloat(tx.toAmount).toFixed(4)} {tx.toToken.symbol}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {transactions.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (chainId) {
                localStorage.removeItem(`transactions_${chainId}`);
                setTransactions([]);
              }
            }}
            className="w-full mt-2 bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
          >
            Clear History
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
