import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function About() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">關於 Stocksr</h1>
            <p className="text-xs text-muted-foreground">支撐阻力技術分析工具</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">關於 Stocksr</h2>
          <div className="prose prose-sm max-w-none text-muted-foreground space-y-4">
            <p>
              <strong>Stocksr</strong> 是一款專業的支撐阻力技術分析工具，幫助投資者找出股票走勢中的關鍵價位。
            </p>
            <p>
              我們的演算法結合多種技術分析方法，包括：
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li>移動平均線 (MA20, MA50, MA200)</li>
              <li>真實波幅指標 (ATR)</li>
              <li>樞紐點 (Pivot Points)</li>
              <li>斐波那契回撤 (Fibonacci Retracement)</li>
              <li> Camarilla 樞紐</li>
              <li>盤整平台偵測</li>
              <li>歷史轉折點</li>
            </ul>
            <p>
              資料來源為 Yahoo Finance，提供全球主要市場的股票數據，包括美國、香港、台灣、中國、日本、韓國等交易所。
            </p>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">常見問題</h2>
          <div className="space-y-4">
            <div>
              <h3 className="font-medium mb-1">Q: 這個工具收費嗎？</h3>
              <p className="text-sm text-muted-foreground">A: Stocksr 完全免費使用，仅供教育与投资参考目的。</p>
            </div>
            <div>
              <h3 className="font-medium mb-1">Q: 資料是即時的嗎？</h3>
              <p className="text-sm text-muted-foreground">A: 否，目前價格採用最後收盤價，並非即時報價。</p>
            </div>
            <div>
              <h3 className="font-medium mb-1">Q: 支持哪些市場？</h3>
              <p className="text-sm text-muted-foreground">A: 支持美國、香港、台灣、上海、深圳、日本、韓國、倫敦等主要交易所。</p>
            </div>
            <div>
              <h3 className="font-medium mb-1">Q: 分析結果準確嗎？</h3>
              <p className="text-sm text-muted-foreground">A: 技術分析僅供參考，過往表現不代表未來結果。請自行判斷並承擔投資風險。</p>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">聯絡我們</h2>
          <p className="text-sm text-muted-foreground">
            如有問題或建議，歡迎透過 GitHub 或其他管道聯繫。
          </p>
        </Card>

        <div className="text-center text-sm text-muted-foreground">
          <p>© {new Date().getFullYear()} Stocksr — 支撐阻力技術分析工具</p>
        </div>
      </main>
    </div>
  );
}

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