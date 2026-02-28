import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId } from "wagmi";
import {
  ArrowLeftRight, Droplets, MinusCircle, LayoutGrid, Globe,
  Bell, ArrowRight, Clock, Check, AlertTriangle, ExternalLink, X, RotateCcw,
} from "lucide-react";
import {
  getPendingTransfers,
  getResumableTransfers,
  removeTransfer,
  type PendingBridgeTransfer,
} from "@/lib/bridge-transfers";
import { getChainByDomain, CCTP_TESTNET_CHAINS } from "@/lib/cctp-config";

export function Header() {
  const { isConnected, address } = useAccount();
  const chainId = useChainId();
  const [location, setLocation] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [pendingTransfers, setPendingTransfers] = useState<PendingBridgeTransfer[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const notifBtnRef = useRef<HTMLButtonElement>(null);

  const chainDisplayInfo = chainId === 2201 
    ? { name: "Stable Testnet", logo: "/img/logos/stable-network.png" }
    : { name: "ARC Testnet", logo: "/img/logos/arc-network.png" };

  // Load pending transfers
  const refreshTransfers = useCallback(() => {
    const transfers = address ? getPendingTransfers().filter(
      t => t.userAddress.toLowerCase() === address.toLowerCase()
    ) : [];
    setPendingTransfers(transfers);
  }, [address]);

  useEffect(() => { refreshTransfers(); }, [refreshTransfers]);

  // Listen for bridge transfer updates
  useEffect(() => {
    const handler = () => refreshTransfers();
    window.addEventListener("bridge-transfers-updated", handler);
    return () => window.removeEventListener("bridge-transfers-updated", handler);
  }, [refreshTransfers]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
    setNotifOpen(false);
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

  // Close notification on outside click
  useEffect(() => {
    if (!notifOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        notifRef.current && !notifRef.current.contains(target) &&
        notifBtnRef.current && !notifBtnRef.current.contains(target)
      ) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [notifOpen]);

  // Close on Escape
  useEffect(() => {
    if (!mobileMenuOpen && !notifOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileMenuOpen(false);
        setNotifOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [mobileMenuOpen, notifOpen]);

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

  const resumableCount = address ? getResumableTransfers(address).length : 0;

  const handleResume = (transfer: PendingBridgeTransfer) => {
    setNotifOpen(false);
    // Navigate to bridge with resume state via custom event
    window.dispatchEvent(new CustomEvent("bridge-resume-transfer", { detail: transfer }));
    setLocation("/bridge");
  };

  const handleDismiss = (id: string) => {
    removeTransfer(id);
    refreshTransfers();
  };

  const getStatusInfo = (status: PendingBridgeTransfer["status"]) => {
    switch (status) {
      case "attesting": return { label: "Waiting for attestation", color: "#f59e0b", Icon: Clock };
      case "ready_to_mint": return { label: "Ready to mint", color: "#4ade80", Icon: Check };
      case "minting": return { label: "Minting...", color: "#818cf8", Icon: RotateCcw };
      case "complete": return { label: "Complete", color: "#4ade80", Icon: Check };
      case "failed": return { label: "Failed", color: "#f87171", Icon: AlertTriangle };
      default: return { label: status, color: "#818cf8", Icon: Clock };
    }
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
          {/* Notification bell */}
          <div className="relative">
            <button
              ref={notifBtnRef}
              onClick={() => { setNotifOpen(!notifOpen); setMobileMenuOpen(false); }}
              className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-muted/50 border border-border/40 hover:bg-muted/70 transition-all duration-200"
              aria-label="Bridge notifications"
            >
              <Bell className="w-4 h-4 text-foreground/70" />
              {resumableCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white animate-pulse">
                  {resumableCount}
                </span>
              )}
            </button>

            {/* Notification dropdown */}
            {notifOpen && (
              <div
                ref={notifRef}
                className="absolute right-0 top-full mt-2 w-80 sm:w-96 z-[60]"
                style={{
                  background: "rgba(15,18,30,0.97)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 16,
                  overflow: "hidden",
                  maxHeight: "70vh",
                  boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
                }}
              >
                {/* Notif header */}
                <div style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "white" }}>Bridge Transfers</span>
                  <button
                    onClick={() => setNotifOpen(false)}
                    style={{
                      width: 24, height: 24, borderRadius: 6,
                      background: "rgba(255,255,255,0.06)", border: "none",
                      color: "rgba(255,255,255,0.5)", cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <X style={{ width: 12, height: 12 }} />
                  </button>
                </div>

                {/* Transfer list */}
                <div style={{ overflowY: "auto", maxHeight: "50vh" }}>
                  {pendingTransfers.length === 0 ? (
                    <div style={{
                      padding: "32px 16px",
                      textAlign: "center",
                      color: "rgba(255,255,255,0.3)",
                      fontSize: 13,
                    }}>
                      <Bell style={{ width: 24, height: 24, margin: "0 auto 8px", opacity: 0.3 }} />
                      No bridge transfers yet
                    </div>
                  ) : (
                    pendingTransfers.map(transfer => {
                      const srcChain = getChainByDomain(transfer.sourceDomain);
                      const dstChain = getChainByDomain(transfer.destDomain);
                      const { label, color, Icon } = getStatusInfo(transfer.status);
                      const isResumable = transfer.status === "attesting" || transfer.status === "ready_to_mint";
                      const age = Date.now() - transfer.timestamp;
                      const ageStr = age < 60000 ? "<1m ago"
                        : age < 3600000 ? `${Math.floor(age / 60000)}m ago`
                        : age < 86400000 ? `${Math.floor(age / 3600000)}h ago`
                        : `${Math.floor(age / 86400000)}d ago`;

                      return (
                        <div
                          key={transfer.id}
                          style={{
                            padding: "12px 16px",
                            borderBottom: "1px solid rgba(255,255,255,0.04)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                          }}
                        >
                          {/* Route + amount */}
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "white" }}>
                              <span style={{
                                width: 18, height: 18, borderRadius: "50%",
                                background: `linear-gradient(135deg, ${srcChain?.color || "#666"}44, ${srcChain?.color || "#666"}88)`,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                fontSize: 8, fontWeight: 800, color: srcChain?.color || "#666",
                                flexShrink: 0,
                              }}>
                                {srcChain?.shortName.charAt(0) || "?"}
                              </span>
                              {srcChain?.shortName || "?"}
                              <ArrowRight style={{ width: 12, height: 12, color: "#818cf8" }} />
                              <span style={{
                                width: 18, height: 18, borderRadius: "50%",
                                background: `linear-gradient(135deg, ${dstChain?.color || "#666"}44, ${dstChain?.color || "#666"}88)`,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                fontSize: 8, fontWeight: 800, color: dstChain?.color || "#666",
                                flexShrink: 0,
                              }}>
                                {dstChain?.shortName.charAt(0) || "?"}
                              </span>
                              {dstChain?.shortName || "?"}
                            </div>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "white" }}>
                              {transfer.amount} USDC
                            </span>
                          </div>

                          {/* Status + actions */}
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <Icon style={{ width: 12, height: 12, color }} />
                              <span style={{ fontSize: 11, fontWeight: 600, color }}>{label}</span>
                              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>{ageStr}</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {transfer.burnTxHash && srcChain && (
                                <a
                                  href={`${srcChain.explorerUrl}${srcChain.explorerTxPath}${transfer.burnTxHash}`}
                                  target="_blank" rel="noopener noreferrer"
                                  style={{ color: "#818cf8", display: "flex" }}
                                  title="View burn tx"
                                >
                                  <ExternalLink style={{ width: 12, height: 12 }} />
                                </a>
                              )}
                              {isResumable && (
                                <button
                                  onClick={() => handleResume(transfer)}
                                  style={{
                                    fontSize: 10, fontWeight: 700, color: "#4ade80",
                                    padding: "2px 8px", borderRadius: 6,
                                    background: "rgba(74,222,128,0.1)",
                                    border: "1px solid rgba(74,222,128,0.25)",
                                    cursor: "pointer",
                                    display: "flex", alignItems: "center", gap: 4,
                                  }}
                                >
                                  <RotateCcw style={{ width: 10, height: 10 }} />
                                  Resume
                                </button>
                              )}
                              {(transfer.status === "complete" || transfer.status === "failed") && (
                                <button
                                  onClick={() => handleDismiss(transfer.id)}
                                  style={{
                                    fontSize: 10, color: "rgba(255,255,255,0.3)",
                                    padding: "2px 6px", borderRadius: 4,
                                    background: "rgba(255,255,255,0.04)",
                                    border: "1px solid rgba(255,255,255,0.08)",
                                    cursor: "pointer",
                                  }}
                                >
                                  Dismiss
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

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
            ref={toggleRef}
            className="md:hidden flex flex-col items-center justify-center w-9 h-9 rounded-lg bg-muted/50 border border-border/40 hover:bg-muted/70 transition-all duration-200"
            onClick={() => { setMobileMenuOpen(prev => !prev); setNotifOpen(false); }}
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

            {/* Pending transfers shortcut in mobile menu */}
            {resumableCount > 0 && (
              <button
                onClick={() => { setMobileMenuOpen(false); setNotifOpen(true); }}
                className="flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-xl transition-all duration-200 text-amber-400 bg-amber-500/10 border border-amber-500/20 mt-1"
              >
                <Bell className="w-4 h-4 flex-shrink-0 text-amber-400" />
                {resumableCount} pending transfer{resumableCount > 1 ? "s" : ""}
              </button>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
