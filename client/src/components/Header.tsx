import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  ArrowLeftRight, Droplets, MinusCircle, LayoutGrid, Globe,
  AlertTriangle,
} from "lucide-react";

export function Header() {
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const isBridgePage = location.startsWith("/bridge");

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  // Close mobile menu on outside click (exclude toggle button)
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        toggleRef.current && !toggleRef.current.contains(target)
      ) {
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
      if (e.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [mobileMenuOpen]);

  const navItems = [
    { href: "/", label: "Swap", testId: "link-swap", icon: ArrowLeftRight },
    { href: "/add-liquidity", label: "Liquidity", testId: "link-add-liquidity", icon: Droplets },
    { href: "/remove-liquidity", label: "Remove", testId: "link-remove-liquidity", icon: MinusCircle },
    { href: "/pools", label: "Pools", testId: "link-pools", icon: LayoutGrid },
    { href: "/bridge", label: "Bridge", testId: "link-bridge", icon: Globe },
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
            {navItems.map(item => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-testid={item.testId}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-all duration-300 hover:scale-105 relative group flex items-center gap-1.5 ${
                    isActive(item.href)
                      ? "text-white bg-primary/15"
                      : "text-foreground hover:bg-accent/80 hover:text-accent-foreground"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 opacity-60" />
                  <span className="relative z-10">{item.label}</span>
                  <span className="absolute inset-0 bg-primary/10 rounded-lg scale-0 group-hover:scale-100 transition-transform duration-300"></span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2 md:gap-3 fade-in">
          <ConnectButton.Custom>
            {({
              account,
              chain,
              openAccountModal,
              openChainModal,
              openConnectModal,
              mounted,
            }) => {
              const ready = mounted;
              const connected = ready && account && chain;

              return (
                <div
                  {...(!ready && {
                    "aria-hidden": true,
                    style: {
                      opacity: 0,
                      pointerEvents: "none" as const,
                      userSelect: "none" as const,
                    },
                  })}
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  {(() => {
                    if (!connected) {
                      return (
                        <button
                          onClick={openConnectModal}
                          className="px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-primary to-blue-500 text-white hover:opacity-90 transition-all duration-200 shadow-md hover:shadow-lg"
                        >
                          Connect Wallet
                        </button>
                      );
                    }

                    // Wrong chain — only show on non-bridge pages
                    if (chain.unsupported && !isBridgePage) {
                      return (
                        <>
                          <button
                            onClick={openChainModal}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all duration-200"
                            style={{
                              background: "rgba(239,68,68,0.15)",
                              border: "1px solid rgba(239,68,68,0.4)",
                              color: "#fca5a5",
                            }}
                          >
                            <AlertTriangle className="w-4 h-4" style={{ color: "#ef4444" }} />
                            <span className="hidden sm:inline">Wrong Network</span>
                            <span className="sm:hidden">Wrong</span>
                          </button>
                          <button
                            onClick={openAccountModal}
                            className="flex items-center gap-1.5 px-2 md:px-3 py-2 bg-muted/50 rounded-lg border border-border/40 hover:border-primary/60 hover:bg-muted/70 transition-all duration-200 text-sm font-medium text-white"
                          >
                            {account.displayName}
                          </button>
                        </>
                      );
                    }

                    // Correct chain (or any chain on Bridge page)
                    return (
                      <>
                        {/* Chain button — show Arc on non-bridge pages, hide on bridge */}
                        {!isBridgePage && (
                          <button
                            onClick={openChainModal}
                            className="flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-2 bg-muted/50 rounded-lg border border-primary/30 hover:border-primary/60 hover:bg-muted/70 transition-all duration-300 cursor-pointer group"
                            title="Switch network"
                          >
                            {chain.hasIcon && (
                              <div
                                style={{
                                  width: 20,
                                  height: 20,
                                  borderRadius: "50%",
                                  overflow: "hidden",
                                  background: chain.iconBackground,
                                }}
                              >
                                {chain.iconUrl && (
                                  <img
                                    alt={chain.name ?? "Chain"}
                                    src={chain.iconUrl}
                                    style={{ width: 20, height: 20 }}
                                  />
                                )}
                              </div>
                            )}
                            {!chain.hasIcon && (
                              <img
                                src="/img/logos/arc-network.png"
                                alt="ARC Testnet"
                                className="h-4 w-4 md:h-5 md:w-5 rounded-full"
                              />
                            )}
                            <span className="hidden sm:inline text-xs md:text-sm font-medium text-white whitespace-nowrap">
                              {chain.name}
                            </span>
                            <span className="h-1.5 w-1.5 md:h-2 md:w-2 bg-green-500 rounded-full animate-pulse"></span>
                          </button>
                        )}

                        {/* Account button */}
                        <button
                          onClick={openAccountModal}
                          className="flex items-center gap-1.5 px-2 md:px-3 py-2 bg-muted/50 rounded-lg border border-border/40 hover:border-primary/60 hover:bg-muted/70 transition-all duration-200 text-sm font-medium text-white"
                        >
                          {account.displayName}
                        </button>
                      </>
                    );
                  })()}
                </div>
              );
            }}
          </ConnectButton.Custom>

          {/* Mobile hamburger button */}
          <button
            ref={toggleRef}
            className="md:hidden flex flex-col items-center justify-center w-9 h-9 rounded-lg bg-muted/50 border border-border/40 hover:bg-muted/70 transition-all duration-200"
            onClick={() => setMobileMenuOpen(prev => !prev)}
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
          maxHeight: mobileMenuOpen ? "400px" : "0",
          opacity: mobileMenuOpen ? 1 : 0,
        }}
      >
        <nav className="border-t border-border/40 bg-background/95 backdrop-blur-xl">
          <div className="container px-4 py-3 max-w-7xl mx-auto flex flex-col gap-1">
            {navItems.map(item => {
              const Icon = item.icon;
              return (
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
                  <Icon className={`w-4 h-4 flex-shrink-0 ${isActive(item.href) ? "text-primary" : "text-foreground/40"}`} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </header>
  );
}
