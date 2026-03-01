import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  ArrowLeftRight, Droplets, MinusCircle, LayoutGrid, Globe,
  AlertTriangle, Menu, X,
} from "lucide-react";

export function Header() {
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const isBridgePage = location.startsWith("/bridge");

  // Close on route change
  useEffect(() => { setMenuOpen(false); }, [location]);

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(t) &&
        toggleRef.current && !toggleRef.current.contains(t)
      ) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  // Close on Escape
  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [menuOpen]);

  // Remove focusable children from tab order when menu is closed
  const syncTabIndex = useCallback(() => {
    const el = menuRef.current;
    if (!el) return;
    const focusables = el.querySelectorAll<HTMLElement>("a, button, input, [tabindex]");
    focusables.forEach(f => { f.tabIndex = menuOpen ? 0 : -1; });
  }, [menuOpen]);

  useEffect(() => { syncTabIndex(); }, [syncTabIndex]);

  const navItems = [
    { href: "/",               label: "Swap",     testId: "link-swap",            icon: ArrowLeftRight },
    { href: "/add-liquidity",  label: "Liquidity", testId: "link-add-liquidity",  icon: Droplets },
    { href: "/remove-liquidity", label: "Remove",  testId: "link-remove-liquidity", icon: MinusCircle },
    { href: "/pools",          label: "Pools",     testId: "link-pools",           icon: LayoutGrid },
    { href: "/bridge",         label: "Bridge",    testId: "link-bridge",          icon: Globe },
  ];

  const isActive = (href: string) =>
    href === "/" ? location === "/" : location.startsWith(href);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 shadow-lg">
      <div className="container flex h-16 items-center justify-between px-4 md:px-6 max-w-7xl mx-auto">

        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 hover:scale-105 transition-all duration-300 px-2 py-1.5 rounded-lg -ml-2 group">
          <img
            src="/img/logos/achswap-logo.png"
            alt="Achswap"
            className="h-9 w-9 md:h-10 md:w-10 rounded-lg group-hover:rotate-12 transition-transform duration-300"
          />
          <span className="text-lg md:text-xl font-bold bg-gradient-to-r from-primary via-blue-500 to-blue-600 bg-clip-text text-transparent animate-gradient">
            Achswap
          </span>
        </Link>

        {/* Right side: wallet + hamburger */}
        <div className="flex items-center gap-2 md:gap-3">

          {/* Wallet / chain buttons */}
          <ConnectButton.Custom>
            {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
              const ready = mounted;
              const connected = ready && account && chain;
              return (
                <div
                  {...(!ready && { "aria-hidden": true })}
                  style={{
                    ...(!ready ? { opacity: 0, pointerEvents: "none" as const, userSelect: "none" as const } : {}),
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {!connected ? (
                    <button
                      onClick={openConnectModal}
                      className="px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-primary to-blue-500 text-white hover:opacity-90 transition-all duration-200 shadow-md hover:shadow-lg"
                    >
                      Connect Wallet
                    </button>
                  ) : chain.unsupported && !isBridgePage ? (
                    <>
                      <button
                        onClick={openChainModal}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all duration-200"
                        style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5" }}
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
                  ) : (
                    <>
                      {!isBridgePage && (
                        <button
                          onClick={openChainModal}
                          className="flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-2 bg-muted/50 rounded-lg border border-primary/30 hover:border-primary/60 hover:bg-muted/70 transition-all duration-300 cursor-pointer"
                          title="Switch network"
                        >
                          {chain.hasIcon ? (
                            <div style={{ width: 20, height: 20, borderRadius: "50%", overflow: "hidden", background: chain.iconBackground }}>
                              {chain.iconUrl && <img alt={chain.name ?? "Chain"} src={chain.iconUrl} style={{ width: 20, height: 20 }} />}
                            </div>
                          ) : (
                            <img src="/img/logos/arc-network.png" alt="ARC Testnet" className="h-4 w-4 md:h-5 md:w-5 rounded-full" />
                          )}
                          <span className="hidden sm:inline text-xs md:text-sm font-medium text-white whitespace-nowrap">{chain.name}</span>
                          <span className="h-1.5 w-1.5 md:h-2 md:w-2 bg-green-500 rounded-full animate-pulse" />
                        </button>
                      )}
                      <button
                        onClick={openAccountModal}
                        className="flex items-center gap-1.5 px-2 md:px-3 py-2 bg-muted/50 rounded-lg border border-border/40 hover:border-primary/60 hover:bg-muted/70 transition-all duration-200 text-sm font-medium text-white"
                      >
                        {account.displayName}
                      </button>
                    </>
                  )}
                </div>
              );
            }}
          </ConnectButton.Custom>

          {/* Hamburger — always visible on all screen sizes */}
          <button
            ref={toggleRef}
            onClick={() => setMenuOpen(p => !p)}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            aria-controls="main-nav-menu"
            data-testid="mobile-menu-toggle"
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted/50 border border-border/40 hover:bg-muted/70 transition-all duration-200"
          >
            {menuOpen
              ? <X className="w-4 h-4 text-foreground/80" />
              : <Menu className="w-4 h-4 text-foreground/80" />
            }
          </button>
        </div>
      </div>

      {/* Dropdown nav — all screen sizes */}
      <div
        id="main-nav-menu"
        ref={menuRef}
        aria-hidden={!menuOpen}
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: menuOpen ? "480px" : "0",
          opacity: menuOpen ? 1 : 0,
          pointerEvents: menuOpen ? "auto" : "none",
        }}
      >
        <nav className="border-t border-border/40 bg-background/95 backdrop-blur-xl">
          <div className="container px-4 py-3 max-w-7xl mx-auto">
            {/* Grid: 1 col on mobile, 2–3 cols on wider screens */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
              {navItems.map(item => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    data-testid={item.testId}
                    className={`flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-xl transition-all duration-200 ${
                      active
                        ? "text-white bg-primary/15 border border-primary/20"
                        : "text-foreground/80 hover:bg-accent/60 hover:text-accent-foreground border border-transparent"
                    }`}
                  >
                    <Icon className={`w-4 h-4 flex-shrink-0 ${active ? "text-primary" : "text-foreground/40"}`} />
                    <span>{item.label}</span>
                    {active && (
                      <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>
      </div>
    </header>
  );
}
