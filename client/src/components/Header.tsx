import { Link } from "wouter";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId } from "wagmi";

export function Header() {
  const { isConnected } = useAccount();
  const chainId = useChainId();

  const chainDisplayInfo = chainId === 2201 
    ? { name: "Stable Testnet", logo: "/img/logos/stable-network.png" }
    : { name: "ARC Testnet", logo: "/img/logos/arc-network.png" };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 shadow-lg">
      <div className="container flex h-16 items-center justify-between px-4 md:px-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-4 md:gap-8 slide-in">
          <Link href="/" className="flex items-center gap-2 hover:scale-105 transition-all duration-300 px-2 py-1.5 rounded-lg -ml-2 group">
            <img src="/img/logos/achswap-logo.png" alt="Achswap" className="h-9 w-9 md:h-10 md:w-10 rounded-lg group-hover:rotate-12 transition-transform duration-300" onError={(e) => console.error('Failed to load logo:', e)} />
            <span className="hidden sm:inline text-lg md:text-xl font-bold bg-gradient-to-r from-primary via-blue-500 to-blue-600 bg-clip-text text-transparent animate-gradient">
              Achswap
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            <Link href="/" data-testid="link-swap" className="px-4 py-2 text-sm font-medium text-foreground hover:bg-accent/80 hover:text-accent-foreground rounded-lg transition-all duration-300 hover:scale-105 relative group">
              <span className="relative z-10">Swap</span>
              <span className="absolute inset-0 bg-primary/10 rounded-lg scale-0 group-hover:scale-100 transition-transform duration-300"></span>
            </Link>
            <Link href="/add-liquidity" data-testid="link-add-liquidity" className="px-4 py-2 text-sm font-medium text-foreground hover:bg-accent/80 hover:text-accent-foreground rounded-lg transition-all duration-300 hover:scale-105 relative group">
              <span className="relative z-10">Liquidity</span>
              <span className="absolute inset-0 bg-primary/10 rounded-lg scale-0 group-hover:scale-100 transition-transform duration-300"></span>
            </Link>
            <Link href="/remove-liquidity" data-testid="link-remove-liquidity" className="px-4 py-2 text-sm font-medium text-foreground hover:bg-accent/80 hover:text-accent-foreground rounded-lg transition-all duration-300 hover:scale-105 relative group">
              <span className="relative z-10">Remove</span>
              <span className="absolute inset-0 bg-primary/10 rounded-lg scale-0 group-hover:scale-100 transition-transform duration-300"></span>
            </Link>
            <Link href="/pools" data-testid="link-pools" className="px-4 py-2 text-sm font-medium text-foreground hover:bg-accent/80 hover:text-accent-foreground rounded-lg transition-all duration-300 hover:scale-105 relative group">
              <span className="relative z-10">Pools</span>
              <span className="absolute inset-0 bg-primary/10 rounded-lg scale-0 group-hover:scale-100 transition-transform duration-300"></span>
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-2 md:gap-3 fade-in">
          <button
            onClick={() => (document.querySelector('[data-testid="connect-wallet-button"] button') as HTMLButtonElement)?.click()}
            className="flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-2 bg-muted/50 rounded-lg border border-primary/30 hover:border-primary/60 hover:bg-muted/70 transition-all duration-300 cursor-pointer group"
            title="Click to switch network"
          >
            <img 
              src={chainDisplayInfo.logo} 
              alt={chainDisplayInfo.name} 
              className="h-4 w-4 md:h-5 md:w-5 rounded-full" 
              onError={(e) => console.error('Failed to load network logo:', e)} 
            />
            <span className="text-xs md:text-sm font-medium text-white whitespace-nowrap">
              {chainDisplayInfo.name}
            </span>
            <span className="h-1.5 w-1.5 md:h-2 md:w-2 bg-green-500 rounded-full animate-pulse"></span>
          </button>

          <div data-testid="connect-wallet-button">
            <ConnectButton
              showBalance={false}
              chainStatus="none"
            />
          </div>
        </div>
      </div>

      <nav className="md:hidden border-t border-border/40 bg-background/50">
        <div className="container px-4 py-2 flex items-center justify-center gap-1 overflow-x-auto max-w-7xl mx-auto">
          <Link href="/" data-testid="link-swap-mobile" className="px-3 py-2 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground rounded-lg transition-colors whitespace-nowrap">
            Swap
          </Link>
          <Link href="/add-liquidity" data-testid="link-add-liquidity-mobile" className="px-3 py-2 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground rounded-lg transition-colors whitespace-nowrap">
            Add Liquidity
          </Link>
          <Link href="/remove-liquidity" data-testid="link-remove-liquidity-mobile" className="px-3 py-2 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground rounded-lg transition-colors whitespace-nowrap">
            Remove
          </Link>
          <Link href="/pools" data-testid="link-pools-mobile" className="px-3 py-2 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground rounded-lg transition-colors whitespace-nowrap">
            Pools
          </Link>
        </div>
      </nav>
    </header>
  );
}