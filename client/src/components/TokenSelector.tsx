import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Search, CheckCircle2, AlertCircle, HelpCircle, X } from "lucide-react";
import { useAccount, useBalance } from "wagmi";
import { formatUnits, isAddress } from "ethers";
import type { Token } from "@shared/schema";
import { formatAmount } from "@/lib/decimal-utils";

interface TokenSelectorProps {
  open: boolean;
  onClose: () => void;
  onSelect: (token: Token) => void;
  tokens: Token[];
  onImport?: (address: string) => Promise<Token | null>;
}

export function TokenSelector({ open, onClose, onSelect, tokens, onImport }: TokenSelectorProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const { address: userAddress } = useAccount();

  const filteredTokens = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return tokens;
    
    return tokens.filter(token =>
      token.symbol.toLowerCase().includes(query) ||
      token.name.toLowerCase().includes(query) ||
      token.address.toLowerCase().includes(query)
    );
  }, [tokens, searchQuery]);

  const isValidAddress = searchQuery.trim() && isAddress(searchQuery.trim());
  
  // Check if token already exists in the list (including default tokens)
  const tokenExists = isValidAddress && tokens.find(t => t.address.toLowerCase() === searchQuery.trim().toLowerCase());
  const showImportButton = isValidAddress && !tokenExists;

  const handleImport = async () => {
    if (!onImport || !searchQuery.trim()) return;
    
    setIsImporting(true);
    setImportError("");
    
    try {
      const token = await onImport(searchQuery.trim());
      if (token) {
        onSelect(token);
        setSearchQuery("");
      }
    } catch (error: any) {
      setImportError(error.message || "Failed to import token");
    } finally {
      setIsImporting(false);
    }
  };

  const handleSelect = (token: Token) => {
    onSelect(token);
    setSearchQuery("");
    setImportError("");
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md max-h-[90vh] sm:max-h-[85vh] flex flex-col p-4 sm:p-6 bg-slate-900 border-slate-700" hideDefaultClose>
        <DialogHeader className="relative flex-shrink-0">
          <DialogTitle className="text-lg sm:text-xl font-semibold pr-8 text-white">Select a token</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-8 w-8 hover:bg-slate-700 text-white"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            data-testid="input-token-search"
            placeholder="Search name or paste address"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
          />
        </div>

        {importError && (
          <div className="flex items-center gap-2 text-sm text-red-300 bg-red-900 p-3 rounded-md border border-red-700">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{importError}</span>
          </div>
        )}

        {showImportButton && (
          <div className="border border-yellow-600 bg-yellow-900 rounded-md p-3 sm:p-4 flex-shrink-0">
            <div className="flex items-start gap-2 mb-3">
              <AlertCircle className="h-4 w-4 sm:h-5 sm:w-5 text-yellow-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium text-xs sm:text-sm text-white">Import token</p>
                <p className="text-xs text-yellow-200 mt-1">
                  This token doesn't appear in the active token list.
                </p>
              </div>
            </div>
            <Button 
              data-testid="button-import-token"
              onClick={handleImport} 
              disabled={isImporting}
              className="w-full text-sm bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {isImporting ? "Importing..." : "Import Token"}
            </Button>
          </div>
        )}

        <ScrollArea className="flex-1 -mx-4 sm:-mx-6 px-4 sm:px-6 min-h-0 bg-slate-800 rounded-lg">
          <div className="space-y-1 py-2">
            {filteredTokens.length === 0 && !showImportButton ? (
              <div className="text-center py-12 text-slate-400">
                <p className="text-sm">No tokens found</p>
              </div>
            ) : (
              filteredTokens.map((token) => (
                <TokenRow
                  key={token.address}
                  token={token}
                  userAddress={userAddress}
                  onClick={() => handleSelect(token)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function TokenRow({ token, userAddress, onClick }: { token: Token; userAddress?: string; onClick: () => void }) {
  // Handle native token (USDC on ARC testnet) vs ERC20 tokens
  const isNativeToken = token.address === "0x0000000000000000000000000000000000000000";
  
  const { data: balance } = useBalance({
    address: userAddress as `0x${string}` | undefined,
    ...(isNativeToken ? {} : { token: token.address as `0x${string}` }),
  });

  let displayBalance = "0";
  try {
    if (balance) {
      displayBalance = formatAmount(balance.value, balance.decimals);
    }
  } catch (error) {
    console.error('Error formatting balance for', token.symbol, error);
    displayBalance = "0";
  }

  const [imgError, setImgError] = useState(false);

  return (
    <button
      data-testid={`button-select-token-${token.symbol}`}
      onClick={onClick}
      className="w-full flex items-center justify-between p-2.5 sm:p-3 rounded-md hover:bg-slate-700 active:bg-slate-600 transition-colors text-left border border-transparent hover:border-slate-500"
    >
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-slate-700 flex items-center justify-center overflow-hidden flex-shrink-0 border border-slate-600">
          {token.logoURI && !imgError ? (
            <img 
              src={token.logoURI} 
              alt={token.symbol} 
              className="w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <img 
              src="/img/logos/unknown-token.png" 
              alt="Unknown token" 
              className="w-full h-full object-cover"
            />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-sm sm:text-base truncate text-white">{token.symbol}</span>
            {token.verified && (
              <CheckCircle2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-blue-400 flex-shrink-0" data-testid={`icon-verified-${token.symbol}`} />
            )}
          </div>
          <p className="text-xs sm:text-sm text-slate-400 truncate">{token.name}</p>
        </div>
      </div>
      {userAddress && (
        <div className="text-right flex-shrink-0 ml-2">
          <p className="font-mono text-xs sm:text-sm font-medium tabular-nums text-white" data-testid={`text-balance-${token.symbol}`}>
            {displayBalance}
          </p>
        </div>
      )}
    </button>
  );
}
