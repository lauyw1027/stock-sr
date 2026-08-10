/**
 * Shared Layout – header (with full nav) + footer
 * Used by every page to ensure consistent navigation.
 */

import { Link, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";

const NAV_LINKS = [
  { href: "/", label: "支撐阻力", mobileLabel: "支撐" },
  { href: "/ath-atl", label: "歷史新高", mobileLabel: "歷史新高" },
  { href: "/divergence", label: "背離掃描", mobileLabel: "背離" },
  { href: "/carry-risk", label: "市場風險", mobileLabel: "日圓風險" },
  { href: "/credit-monitor", label: "信用風險監控", mobileLabel: "信用監控" },
  { href: "/credit-spread", label: "期權分析", mobileLabel: "期權分析" },
  { href: "/about", label: "關於", mobileLabel: "關於" },
];

function Logo({ className = "", size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-label="Stocksr 標誌"
    >
      <rect x="1" y="1" width="30" height="30" rx="7" stroke="currentColor" className="text-primary" strokeWidth="1.5" />
      <path d="M6 20 L12 14 L17 18 L26 8" stroke="currentColor" className="text-primary" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="6" y1="24" x2="26" y2="24" stroke="currentColor" className="text-primary/40" strokeWidth="1.5" strokeDasharray="2 2" />
      <line x1="6" y1="11" x2="26" y2="11" stroke="currentColor" className="text-destructive/50" strokeWidth="1.5" strokeDasharray="2 2" />
    </svg>
  );
}

export function Layout({ children, title, subtitle }: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}) {
  const [location] = useHashLocation();

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── Header ── */}
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-6xl px-2 sm:px-4 py-2 sm:py-3 flex items-center gap-2 sm:gap-3">
          <Link href="/">
            <a className="flex items-center gap-2 shrink-0" aria-label="回到首頁">
              <Logo size={24} />
              <span className="font-bold text-sm hidden sm:block tracking-tight">Stocksr</span>
            </a>
          </Link>

          {/* Page title (desktop) */}
          {title && (
            <div className="flex-1 min-w-0 hidden md:block">
              <p className="text-sm font-semibold truncate">{title}</p>
              {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
            </div>
          )}
          {!title && <div className="flex-1" />}

          {/* Nav links - scrollable on mobile */}
          <nav className="flex items-center gap-0.5 sm:gap-1 lg:gap-2 flex-nowrap overflow-x-auto max-w-[calc(100vw-80px)] sm:max-w-none hide-scrollbar">
            {NAV_LINKS.map(({ href, label, mobileLabel }) => {
              const active = location === href || (href !== "/" && location.startsWith(href));
              return (
                <Link key={href} href={href}>
                  <a
                    className={[
                      "flex-shrink-0 text-[10px] sm:text-xs px-1.5 sm:px-2 py-1.5 rounded-md transition-colors whitespace-nowrap",
                      active
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent",
                    ].join(" ")}
                  >
                    <span className="sm:hidden">{mobileLabel}</span>
                    <span className="hidden sm:inline lg:hidden text-[10px]">{label}</span>
                    <span className="hidden lg:inline">{label}</span>
                  </a>
                </Link>
              );
            })}
          </nav>
        </div>
        
        {/* Mobile title bar */}
        {title && (
          <div className="md:hidden px-2 sm:px-4 pb-2">
            <p className="text-sm font-semibold truncate">{title}</p>
            {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
          </div>
        )}
      </header>

      {/* ── Page content ── */}
      <main className="flex-1">
        {children}
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-border mt-8 sm:mt-10">
        <div className="mx-auto max-w-6xl px-2 sm:px-4 py-4 sm:py-6 text-xs text-muted-foreground space-y-1">
          <p className="text-center text-muted-foreground">
            © {new Date().getFullYear()} <strong className="text-foreground">Stocksr</strong> — 支撐阻力技術分析工具
          </p>
          <p>
            <strong className="text-foreground">風險聲明：</strong>
            本工具僅為技術分析與教育用途，非投資建議。資料來源 Yahoo Finance，可能有延遲或誤差。
          </p>
          <p>目前價格採用最後收盤價（非即時報價）。所有指標由 OHLCV 計算，若資料不足則顯示 N/A。</p>
        </div>
      </footer>
    </div>
  );
}
