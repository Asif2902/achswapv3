import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId } from "wagmi";

export function Header() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const chainDisplayInfo = chainId === 2201 
    ? { name: "Stable Testnet", logo: "/img/logos/stable-network.png" }
    : { name: "ARC Testnet", logo: "/img/logos/arc-network.png" };

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  // Close mobile menu on outside click
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [mobileMenuOpen]);

  // Close on Escape
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [mobileMenuOpen]);

  const navItems = [
    { href: "/", label: "Swap", testId: "link-swap" },
    { href: "/add-liquidity", label: "Liquidity", testId: "link-add-liquidity" },
    { href: "/remove-liquidity", label: "Remove", testId: "link-remove-liquidity" },
    { href: "/pools", label: "Pools", testId: "link-pools" },
    { href: "/bridge", label: "Bridge", testId: "link-bridge" },
  ];

  const isActive = (href: string) => {
    if (href === "/") return location === "/";
    return location.startsWith(href);
  };

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

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map(item => (
              <Link
                key={item.href}
                href={item.href}
                data-testid={item.testId}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all duration-300 hover:scale-105 relative group ${
                  isActive(item.href)
                    ? "text-white bg-primary/15"
                    : "text-foreground hover:bg-accent/80 hover:text-accent-foreground"
                }`}
              >
                <span className="relative z-10">{item.label}</span>
                <span className="absolute inset-0 bg-primary/10 rounded-lg scale-0 group-hover:scale-100 transition-transform duration-300"></span>
              </Link>
            ))}
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
            <span className="hidden sm:inline text-xs md:text-sm font-medium text-white whitespace-nowrap">
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

          {/* Mobile hamburger button */}
          <button
            className="md:hidden flex flex-col items-center justify-center w-9 h-9 rounded-lg bg-muted/50 border border-border/40 hover:bg-muted/70 transition-all duration-200"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
            data-testid="mobile-menu-toggle"
          >
            <span
              className="block w-4 h-0.5 bg-foreground/80 rounded-full transition-all duration-300"
              style={{
                transform: mobileMenuOpen ? "rotate(45deg) translate(2px, 2px)" : "none",
              }}
            />
            <span
              className="block w-4 h-0.5 bg-foreground/80 rounded-full my-[3px] transition-all duration-300"
              style={{
                opacity: mobileMenuOpen ? 0 : 1,
                transform: mobileMenuOpen ? "scaleX(0)" : "scaleX(1)",
              }}
            />
            <span
              className="block w-4 h-0.5 bg-foreground/80 rounded-full transition-all duration-300"
              style={{
                transform: mobileMenuOpen ? "rotate(-45deg) translate(2px, -2px)" : "none",
              }}
            />
          </button>
        </div>
      </div>

      {/* Mobile dropdown menu */}
      <div
        ref={menuRef}
        className="md:hidden overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: mobileMenuOpen ? "320px" : "0",
          opacity: mobileMenuOpen ? 1 : 0,
        }}
      >
        <nav className="border-t border-border/40 bg-background/95 backdrop-blur-xl">
          <div className="container px-4 py-3 max-w-7xl mx-auto flex flex-col gap-1">
            {navItems.map(item => (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`${item.testId}-mobile`}
                className={`flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-xl transition-all duration-200 ${
                  isActive(item.href)
                    ? "text-white bg-primary/15 border border-primary/20"
                    : "text-foreground/80 hover:bg-accent/60 hover:text-accent-foreground border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  isActive(item.href) ? "bg-primary" : "bg-foreground/20"
                }`} />
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
}
