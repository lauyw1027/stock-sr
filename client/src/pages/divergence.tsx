import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TrendingUp,
  TrendingDown,
  Search,
  RefreshCw,
  AlertTriangle,
  ArrowUpDown,
  Info,
} from "lucide-react";
import type { DivergenceResult, DivergenceScanResponse, DivergenceResponse, Timeframe, Strength } from "@/lib/types";

// 時間週期選項
const TIMEFRAME_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: "30m", label: "30分鐘" },
  { value: "60m", label: "1小時" },
  { value: "1d", label: "日線" },
  { value: "1wk", label: "週線" },
];

// 交易所選項
const EXCHANGES = ["all", "NYSE", "NASDAQ", "AMEX"] as const;

// 強度篩選選項
const STRENGTH_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "moderate", label: "中以上" },
  { value: "strong", label: "強以上" },
  { value: "very_strong", label: "極強" },
] as const;

// 強度標籤映射
const STRENGTH_LABELS: Record<Strength, string> = {
  weak: "弱",
  moderate: "中",
  strong: "強",
  very_strong: "極強",
};

// 強度顏色映射
const STRENGTH_COLORS: Record<Strength, string> = {
  weak: "bg-muted text-muted-foreground border-border",
  moderate: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  strong: "bg-orange-500/20 text-orange-500 border-orange-500/40",
  very_strong: "bg-red-600/20 text-red-500 border-red-500/40",
};

export default function DivergencePage() {
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [symbolInput, setSymbolInput] = useState("");
  const [activeTab, setActiveTab] = useState<"bullish" | "bearish">("bearish");
  const [exchange, setExchange] = useState<string>("all");
  const [minStrength, setMinStrength] = useState<typeof STRENGTH_OPTIONS[number]["value"]>("moderate");
  const [search, setSearch] = useState("");

  const isIntraday = timeframe === "30m" || timeframe === "60m";

  // 全市場掃描 API (日線/週線)
  const scanMutation = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams();
      params.set("timeframe", timeframe);
      params.set("type", activeTab);
      if (exchange !== "all") params.set("exchange", exchange);
      if (minStrength !== "all") params.set("minStrength", minStrength);
      const res = await apiRequest("GET", `/api/divergence/scan?${params.toString()}`);
      return (await res.json()) as DivergenceScanResponse;
    },
  });

  // 單股查詢 API (30分鐘/1小時)
  const symbolMutation = useMutation({
    mutationFn: async (symbol: string) => {
      const params = new URLSearchParams();
      params.set("symbol", symbol);
      params.set("timeframe", timeframe);
      const res = await apiRequest("GET", `/api/divergence/symbol?${params.toString()}`);
      return (await res.json()) as DivergenceResponse;
    },
  });

  // 處理時間週期變更
  const handleTimeframeChange = (tf: Timeframe) => {
    setTimeframe(tf);
    if (tf === "30m" || tf === "60m") {
      // 清除全市場數據
    } else {
      // 重新獲取全市場數據
      scanMutation.mutate();
    }
  };

  // 處理單股查詢
  const handleSymbolSearch = () => {
    if (!symbolInput.trim()) return;
    symbolMutation.mutate(symbolInput.trim().toUpperCase());
  };

  // 過濾結果
  const filteredResults = useMemo(() => {
    if (!scanMutation.data?.results) return [];
    let results = scanMutation.data.results;

    if (search) {
      const s = search.toLowerCase();
      results = results.filter(
        (r) =>
          r.symbol.toLowerCase().includes(s) ||
          r.company_name.toLowerCase().includes(s)
      );
    }

    return results;
  }, [scanMutation.data?.results, search]);

  // 格式化價格
  const formatPrice = (price: number | undefined | null) => {
    if (price == null || isNaN(price)) return "N/A";
    return `$${price.toFixed(2)}`;
  };

  // 格式化日期
  const formatDate = (date: string) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleDateString("zh-TW");
  };

  // 渲染強度 Badge
  const renderStrengthBadge = (strength: Strength) => (
    <Badge variant="outline" className={STRENGTH_COLORS[strength]}>
      {STRENGTH_LABELS[strength]}
    </Badge>
  );

  // 渲染指標 Badge
  const renderIndicatorBadges = (indicators: string[]) => (
    <div className="flex flex-wrap gap-1">
      {indicators.map((ind) => (
        <Badge key={ind} variant="outline" className="text-xs">
          {ind}
        </Badge>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3">
          <Logo />
          <div className="flex-1">
            <h1 className="text-lg font-semibold tracking-tight">
              背離掃描
            </h1>
            <p className="text-xs text-muted-foreground">
              Divergence Scanner | MACD/RSI/Volume/OBV/MFI
            </p>
          </div>
          <Link href="/">
            <a className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              首頁
            </a>
          </Link>
          <Link href="/ath-atl">
            <a className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              ATH/ATL
            </a>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-4">
        {/* 時間週期切換 */}
        <Card className="p-4">
          <div className="flex flex-wrap gap-2 items-center justify-between">
            <div className="flex gap-2 flex-wrap">
              {TIMEFRAME_OPTIONS.map((tf) => (
                <Button
                  key={tf.value}
                  variant={timeframe === tf.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => handleTimeframeChange(tf.value)}
                >
                  {tf.label}
                </Button>
              ))}
            </div>
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Info className="h-3 w-3" />
              {isIntraday ? "單股即時查詢模式" : "全市場掃描模式"}
            </div>
          </div>
        </Card>

        {/* 全市場掃描模式 (日線/週線) */}
        {!isIntraday && (
          <Card className="p-4">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "bullish" | "bearish")}>
              <div className="flex flex-wrap gap-3 items-center justify-between mb-4">
                <TabsList>
                  <TabsTrigger value="bearish" className="flex items-center gap-1">
                    <TrendingDown className="h-4 w-4 text-red-500" />
                    頂背離
                  </TabsTrigger>
                  <TabsTrigger value="bullish" className="flex items-center gap-1">
                    <TrendingUp className="h-4 w-4 text-green-500" />
                    底背離
                  </TabsTrigger>
                </TabsList>

                <div className="flex gap-2 flex-wrap">
                  <select
                    value={exchange}
                    onChange={(e) => setExchange(e.target.value)}
                    className="px-3 py-1.5 rounded-md border border-border bg-background text-sm"
                  >
                    <option value="all">全部交易所</option>
                    <option value="NYSE">NYSE</option>
                    <option value="NASDAQ">NASDAQ</option>
                    <option value="AMEX">AMEX</option>
                  </select>

                  <select
                    value={minStrength}
                    onChange={(e) => setMinStrength(e.target.value as any)}
                    className="px-3 py-1.5 rounded-md border border-border bg-background text-sm"
                  >
                    {STRENGTH_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => scanMutation.mutate()}
                    disabled={scanMutation.isPending}
                  >
                    <RefreshCw className={`h-4 w-4 mr-1 ${scanMutation.isPending ? "animate-spin" : ""}`} />
                    重新整理
                  </Button>
                </div>
              </div>

              {/* 搜尋框 */}
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜尋代碼或公司名稱..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>

              <TabsContent value={activeTab}>
                {/* 載入中 */}
                {scanMutation.isPending && (
                  <Card className="p-8 text-center">
                    <RefreshCw className="w-8 h-8 mx-auto animate-spin mb-2" />
                    <p className="text-muted-foreground">載入中...</p>
                  </Card>
                )}

                {/* 錯誤 */}
                {scanMutation.isError && (
                  <Card className="p-6 border-destructive/40 bg-destructive/5">
                    <p className="text-destructive">載入失敗：{(scanMutation.error as any)?.message}</p>
                    <Button variant="outline" className="mt-2" onClick={() => scanMutation.mutate()}>
                      重試
                    </Button>
                  </Card>
                )}

                {/* 無結果 */}
                {!scanMutation.isPending && !scanMutation.isError && filteredResults.length === 0 && (
                  <Card className="p-8 text-center">
                    <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-muted-foreground">
                      {search ? "沒有符合搜尋條件的背離訊號" : "目前無符合條件的背離訊號"}
                    </p>
                  </Card>
                )}

                {/* 結果列表 */}
                {!scanMutation.isPending && !scanMutation.isError && filteredResults.length > 0 && (
                  <>
                    <p className="text-xs text-muted-foreground mb-3">
                      找到 {filteredResults.length} 個訊號 | 資料更新：{scanMutation.data?.lastUpdated ? new Date(scanMutation.data.lastUpdated).toLocaleString("zh-TW") : "N/A"}
                    </p>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>代碼</TableHead>
                            <TableHead>公司名稱</TableHead>
                            <TableHead>交易所</TableHead>
                            <TableHead>強度</TableHead>
                            <TableHead>命中指標</TableHead>
                            <TableHead className="text-right">最新價</TableHead>
                            <TableHead className="text-right">擺動點</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredResults.map((record) => (
                            <TableRow
                              key={record.symbol}
                              className={record.divergence_type === "bearish" ? "bg-red-500/5" : "bg-green-500/5"}
                            >
                              <TableCell className="font-mono font-medium">
                                {record.symbol}
                              </TableCell>
                              <TableCell className="max-w-[200px] truncate">
                                {record.company_name}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-xs">
                                  {record.exchange}
                                </Badge>
                              </TableCell>
                              <TableCell>{renderStrengthBadge(record.strength)}</TableCell>
                              <TableCell>{renderIndicatorBadges(record.matched_indicators)}</TableCell>
                              <TableCell className="text-right font-mono">
                                {formatPrice(record.last_close)}
                              </TableCell>
                              <TableCell className="text-right text-xs text-muted-foreground">
                                {formatPrice(record.swing_price_1)} → {formatPrice(record.swing_price_2)}
                                <br />
                                {formatDate(record.swing_date_1)} ~ {formatDate(record.swing_date_2)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </TabsContent>
            </Tabs>
          </Card>
        )}

        {/* 單股查詢模式 (30分鐘/1小時) */}
        {isIntraday && (
          <Card className="p-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[200px] space-y-1.5">
                <Label htmlFor="symbol-input" className="text-xs">股票代號</Label>
                <div className="flex gap-2">
                  <Input
                    id="symbol-input"
                    placeholder="例如 AAPL、NVDA、TSLA"
                    value={symbolInput}
                    onChange={(e) => setSymbolInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSymbolSearch()}
                    className="font-mono"
                  />
                  <Button
                    onClick={handleSymbolSearch}
                    disabled={symbolMutation.isPending || !symbolInput.trim()}
                  >
                    <Search className="mr-2 h-4 w-4" />
                    {symbolMutation.isPending ? "查詢中..." : "查詢"}
                  </Button>
                </div>
              </div>
            </div>

            {/* 查詢結果 */}
            {symbolMutation.data && (
              <div className="mt-4">
                {"status" in symbolMutation.data && (symbolMutation.data.status === "insufficient_data" || symbolMutation.data.status === "no_divergence") ? (
                  <Card className="p-5 border-amber-500/40 bg-amber-500/5">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium">
                          {symbolMutation.data.status === "insufficient_data" 
                            ? "資料不足，無法形成有效背離判斷" 
                            : "未檢測到背離信號"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {symbolMutation.data.message}
                        </p>
                        {"bars_available" in symbolMutation.data && (
                          <p className="text-xs text-muted-foreground">
                            可用：{symbolMutation.data.bars_available} 根K線，需要：{symbolMutation.data.bars_required} 根
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                ) : (
                  <ResultCard
                    result={symbolMutation.data as DivergenceResult}
                    formatPrice={formatPrice}
                    formatDate={formatDate}
                    renderStrengthBadge={renderStrengthBadge}
                    renderIndicatorBadges={renderIndicatorBadges}
                  />
                )}
              </div>
            )}

            {/* 錯誤 */}
            {symbolMutation.isError && (
              <Card className="p-5 border-destructive/40 bg-destructive/5 mt-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">查詢失敗</p>
                    <p className="text-xs text-muted-foreground">
                      {(symbolMutation.error as any)?.message || "請確認股票代號是否正確"}
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {/* 說明 */}
            <div className="mt-4 p-3 rounded-md bg-muted/30 text-xs text-muted-foreground">
              <p className="font-medium mb-1">提示：</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>30分鐘線，建議使用 60 天歷史資料</li>
                <li>1小時線，建議使用 730 天歷史資料</li>
                <li>若資料不足，將顯示「資料不足，無法形成有效背離判斷」</li>
              </ul>
            </div>
          </Card>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-10">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs text-muted-foreground text-center">
          <p>© {new Date().getFullYear()} Stocksr — 背離技術分析工具</p>
          <p className="mt-1">本工具僅為技術分析與教育用途，非投資建議。</p>
        </div>
      </footer>
    </div>
  );
}

// 單股結果卡片
function ResultCard({
  result,
  formatPrice,
  formatDate,
  renderStrengthBadge,
  renderIndicatorBadges,
}: {
  result: DivergenceResult;
  formatPrice: (price: number) => string;
  formatDate: (date: string) => string;
  renderStrengthBadge: (strength: Strength) => JSX.Element;
  renderIndicatorBadges: (indicators: string[]) => JSX.Element;
}) {
  const isBearish = result.divergence_type === "bearish";

  return (
    <Card className={`p-5 ${isBearish ? "border-red-500/30 bg-red-500/5" : "border-green-500/30 bg-green-500/5"}`}>
      {/* 標題 */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold">
            {result.company_name}{" "}
            <span className="text-muted-foreground font-mono text-base">({result.symbol})</span>
          </h2>
          <p className="text-xs text-muted-foreground">
            時間週期：{result.timeframe === "30m" ? "30分鐘" : "1小時"} | 交易所：{result.exchange}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isBearish ? (
            <TrendingDown className="h-5 w-5 text-red-500" />
          ) : (
            <TrendingUp className="h-5 w-5 text-green-500" />
          )}
          <Badge variant="outline" className={isBearish ? "bg-red-500/10 text-red-500" : "bg-green-500/10 text-green-500"}>
            {isBearish ? "頂背離" : "底背離"}
          </Badge>
        </div>
      </div>

      {/* 強度與指標 */}
      <div className="grid gap-4 sm:grid-cols-2 mb-4">
        <div>
          <div className="text-xs text-muted-foreground mb-1">訊號強度</div>
          {renderStrengthBadge(result.strength)}
          <div className="text-xs text-muted-foreground mt-1">
            命中 {result.matched_count} 個指標
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">命中指標</div>
          {result.matched_indicators?.length > 0 ? (
            renderIndicatorBadges(result.matched_indicators)
          ) : (
            <span className="text-sm text-muted-foreground">目前未發現背離訊號</span>
          )}
        </div>
      </div>

      {/* 價格資訊 */}
      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">最新收盤價</div>
          <div className="font-mono font-semibold">{formatPrice(result.last_close)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">擺動點 1</div>
          <div className="font-mono">{formatPrice(result.swing_price_1)}</div>
          <div className="text-xs text-muted-foreground">{formatDate(result.swing_date_1)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">擺動點 2</div>
          <div className="font-mono">{formatPrice(result.swing_price_2)}</div>
          <div className="text-xs text-muted-foreground">{formatDate(result.swing_date_2)}</div>
        </div>
      </div>

      {/* 更新時間 */}
      <div className="mt-4 pt-3 border-t border-border text-xs text-muted-foreground">
        資料更新時間：{formatDate(result.updated_at)}
      </div>
    </Card>
  );
}

// Logo 元件
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