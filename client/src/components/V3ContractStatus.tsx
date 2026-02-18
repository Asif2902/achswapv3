import { useState, useEffect } from "react";
import { useChainId } from "wagmi";
import { BrowserProvider } from "ethers";
import { getContractsForChain } from "@/lib/contracts";
import { verifyV3Contracts } from "@/lib/contract-verification";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function V3ContractStatus() {
  const chainId = useChainId();
  const [status, setStatus] = useState<{
    checking: boolean;
    exists: boolean;
    missing: string[];
    details: Record<string, boolean>;
  }>({ checking: true, exists: false, missing: [], details: {} });

  const checkContracts = async () => {
    if (!chainId) return;

    setStatus(prev => ({ ...prev, checking: true }));

    try {
      // Create provider from public RPC
      const rpcUrl = 'https://rpc.testnet.arc.network';
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method,
              params: params || [],
            }),
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error.message);
          return data.result;
        },
      });

      const contracts = getContractsForChain(chainId);

      const result = await verifyV3Contracts(provider, contracts.v3);
      setStatus({
        checking: false,
        exists: result.exists,
        missing: result.missing,
        details: result.details,
      });
    } catch (error) {
      console.error("Error checking V3 contracts:", error);
      setStatus({
        checking: false,
        exists: false,
        missing: ["Unable to verify contracts"],
        details: {},
      });
    }
  };

  useEffect(() => {
    checkContracts();
  }, [chainId]);

  if (status.checking) {
    return (
      <Card className="bg-slate-800/50 border-slate-700 mb-3 sm:mb-4">
        <CardContent className="p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-slate-400 flex items-center gap-2">
            <div className="animate-spin h-3 w-3 sm:h-4 sm:w-4 border-2 border-blue-500 border-t-transparent rounded-full"></div>
            Checking V3 contracts...
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!status.exists) {
    return (
      <Card className="bg-red-500/10 border-red-500/30 mb-3 sm:mb-4">
        <CardHeader className="pb-2 sm:pb-3 p-3 sm:p-6">
          <CardTitle className="text-xs sm:text-sm font-semibold flex items-center gap-2 text-red-400">
            <XCircle className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />
            <span className="line-clamp-2">V3 Contracts Not Found on ARC Testnet</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 sm:space-y-3 p-3 sm:p-6 pt-0">
          <div className="text-[10px] sm:text-xs text-red-300 space-y-1 sm:space-y-2">
            <p className="font-medium">Missing contracts:</p>
            <ul className="list-disc list-inside space-y-0.5 sm:space-y-1 text-red-200/80 text-[9px] sm:text-xs">
              {status.missing.slice(0, 3).map((contract, index) => (
                <li key={index} className="break-all line-clamp-2">{contract}</li>
              ))}
              {status.missing.length > 3 && (
                <li className="text-red-300/60">... and {status.missing.length - 3} more</li>
              )}
            </ul>
          </div>
          
          <div className="p-2 sm:p-3 bg-yellow-500/10 border border-yellow-500/30 rounded text-[10px] sm:text-xs text-yellow-300">
            <p className="font-semibold mb-0.5 sm:mb-1">⚠️ V3 Features Disabled</p>
            <p className="leading-tight">V3 will not work until contracts are deployed.</p>
          </div>

          <Button
            onClick={checkContracts}
            variant="outline"
            size="sm"
            className="w-full border-red-500/30 text-red-400 hover:bg-red-500/10 h-8 sm:h-9 text-xs"
          >
            Re-check Contracts
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-green-500/10 border-green-500/30 mb-3 sm:mb-4">
      <CardContent className="p-3 sm:p-4">
        <p className="text-xs sm:text-sm text-green-400 flex items-center gap-2">
          <CheckCircle className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />
          <span className="line-clamp-1">All V3 contracts verified on ARC Testnet</span>
        </p>
      </CardContent>
    </Card>
  );
}
