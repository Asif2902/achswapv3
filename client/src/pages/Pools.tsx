
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Search, TrendingUp, Droplets } from "lucide-react";
import { useChainId } from "wagmi";
import { fetchAllPools, calculateTotalTVL, type PoolData } from "@/lib/pool-utils";
import { fetchAllV3Pools, calculateV3TotalTVL, type V3PoolData } from "@/lib/v3-pool-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getTokensByChainId } from "@/data/tokens";

export default function Pools() {
  const [v2Pools, setV2Pools] = useState<PoolData[]>([]);
  const [v3Pools, setV3Pools] = useState<V3PoolData[]>([]);
  const [isLoadingV2, setIsLoadingV2] = useState(false);
  const [isLoadingV3, setIsLoadingV3] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [v2TotalTVL, setV2TotalTVL] = useState(0);
  const [v3TotalTVL, setV3TotalTVL] = useState(0);
  
  const chainId = useChainId();
  const contracts = chainId ? getContractsForChain(chainId) : null;
  const tokens = chainId ? getTokensByChainId(chainId) : [];

  useEffect(() => {
    if (chainId && contracts) {
      loadAllPools();
    }
  }, [chainId]);

  const loadAllPools = async () => {
    loadV2Pools();
    loadV3Pools();
  };

  const loadV2Pools = async () => {
    if (!contracts || !chainId) return;

    setIsLoadingV2(true);
    try {
      const poolData = await fetchAllPools(contracts.v2.factory, chainId, tokens);
      setV2Pools(poolData);
      setV2TotalTVL(calculateTotalTVL(poolData));
    } catch (error) {
      console.error("Failed to load V2 pools:", error);
    } finally {
      setIsLoadingV2(false);
    }
  };

  const loadV3Pools = async () => {
    if (!contracts || !chainId) return;

    setIsLoadingV3(true);
    try {
      const poolData = await fetchAllV3Pools(contracts.v3.factory, chainId, tokens);
      setV3Pools(poolData);
      setV3TotalTVL(calculateV3TotalTVL(poolData));
    } catch (error) {
      console.error("Failed to load V3 pools:", error);
    } finally {
      setIsLoadingV3(false);
    }
  };

  const filteredV2Pools = v2Pools.filter(pool => {
    const query = searchQuery.toLowerCase();
    return (
      pool.token0.symbol.toLowerCase().includes(query) ||
      pool.token1.symbol.toLowerCase().includes(query) ||
      pool.token0.name.toLowerCase().includes(query) ||
      pool.token1.name.toLowerCase().includes(query)
    );
  });

  const filteredV3Pools = v3Pools.filter(pool => {
    const query = searchQuery.toLowerCase();
    return (
      pool.token0.symbol.toLowerCase().includes(query) ||
      pool.token1.symbol.toLowerCase().includes(query) ||
      pool.token0.name.toLowerCase().includes(query) ||
      pool.token1.name.toLowerCase().includes(query)
    );
  });

  const formatNumber = (num: number) => {
    if (num >= 1000000) {
      return `$${(num / 1000000).toFixed(2)}M`;
    } else if (num >= 1000) {
      return `$${(num / 1000).toFixed(2)}K`;
    } else {
      return `$${num.toFixed(2)}`;
    }
  };

  return (
    <div className="container max-w-6xl mx-auto px-4 py-4 md:py-8">
      <div className="mb-4 sm:mb-6 space-y-3 sm:space-y-4">
        <div className="flex items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground">
              Liquidity Pools
            </h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">
              Explore all available trading pairs
            </p>
          </div>
          <Button
            onClick={loadAllPools}
            disabled={isLoadingV2 || isLoadingV3}
            variant="outline"
            size="icon"
            className="h-9 w-9 sm:h-10 sm:w-10 flex-shrink-0"
          >
            <RefreshCw className={`h-4 w-4 ${(isLoadingV2 || isLoadingV3) ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
          <Card className="border-border/40 shadow-lg">
            <CardContent className="pt-4 sm:pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">Total Pools</p>
                  <p className="text-xl sm:text-2xl font-bold">{v2Pools.length + v3Pools.length}</p>
                </div>
                <Droplets className="h-6 w-6 sm:h-8 sm:w-8 text-blue-500" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/40 shadow-lg">
            <CardContent className="pt-4 sm:pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    Total TVL (USD)
                  </p>
                  <p className="text-xl sm:text-2xl font-bold">{formatNumber(v2TotalTVL + v3TotalTVL)}</p>
                </div>
                <TrendingUp className="h-6 w-6 sm:h-8 sm:w-8 text-green-500" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/40 shadow-lg sm:col-span-2 md:col-span-1">
            <CardContent className="pt-4 sm:pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">Active Pairs</p>
                  <p className="text-xl sm:text-2xl font-bold">
                    {v2Pools.filter(p => p.tvlUSD > 0).length + v3Pools.filter(p => p.tvlUSD > 0).length}
                  </p>
                </div>
                <TrendingUp className="h-6 w-6 sm:h-8 sm:w-8 text-primary" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search pools by token name or symbol..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Pools List */}
      <Card className="border-border/40 shadow-xl">
        <CardHeader>
          <CardTitle>All Pools</CardTitle>
        </CardHeader>
        <CardContent>
          {(isLoadingV2 || isLoadingV3) ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : filteredV2Pools.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                {searchQuery ? "No pools found matching your search" : "No pools available"}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredV2Pools.map((pool) => {
                // Try to find token by symbol first, then by display symbol
                const token0Data = tokens.find(t => 
                  t.symbol === pool.token0.symbol || 
                  t.symbol === pool.token0.displaySymbol
                );
                const token1Data = tokens.find(t => 
                  t.symbol === pool.token1.symbol || 
                  t.symbol === pool.token1.displaySymbol
                );
                
                // Use fallback logo if token not found in our list
                const token0Logo = token0Data?.logoURI || "/img/logos/unknown-token.png";
                const token1Logo = token1Data?.logoURI || "/img/logos/unknown-token.png";

                return (
                  <div
                    key={pool.pairAddress}
                    className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3 sm:p-4 rounded-lg border border-border/40 hover:border-primary/40 transition-all duration-300 hover:bg-accent/5 gap-3 sm:gap-4"
                  >
                    <div className="flex items-center gap-3 sm:gap-4 w-full sm:w-auto">
                      <div className="flex items-center -space-x-2">
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full border-2 border-background overflow-hidden flex-shrink-0">
                          <img 
                            src={token0Logo} 
                            alt={pool.token0.displaySymbol}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.currentTarget.src = "/img/logos/unknown-token.png";
                            }}
                          />
                        </div>
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full border-2 border-background overflow-hidden flex-shrink-0">
                          <img 
                            src={token1Logo} 
                            alt={pool.token1.displaySymbol}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.currentTarget.src = "/img/logos/unknown-token.png";
                            }}
                          />
                        </div>
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-base sm:text-lg text-foreground">
                          {pool.token0.displaySymbol}/{pool.token1.displaySymbol}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {pool.token0.name} / {pool.token1.name}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-4 w-full sm:w-auto">
                      <div className="text-left sm:text-right space-y-1">
                        <p className="font-semibold text-base sm:text-lg text-foreground">
                          {formatNumber(pool.tvlUSD)}
                        </p>
                        <p className="text-xs text-muted-foreground">TVL (USD)</p>
                      </div>

                      <div className="text-right space-y-1">
                        <p className="font-mono text-xs sm:text-sm text-foreground">
                          {parseFloat(pool.reserve0Formatted).toFixed(4)} {pool.token0.displaySymbol}
                        </p>
                        <p className="font-mono text-xs sm:text-sm text-foreground">
                          {parseFloat(pool.reserve1Formatted).toFixed(4)} {pool.token1.displaySymbol}
                        </p>
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.location.href = '/add-liquidity'}
                        className="flex-shrink-0"
                      >
                        Add
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
