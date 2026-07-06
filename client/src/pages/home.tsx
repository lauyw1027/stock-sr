import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Minus,
  Search,
  AlertTriangle,
  Info,
  Download,
  Activity,
  Layers,
} from "lucide-react";
import type {
  AnalyzeResult,
  AmbiguousResponse,
  ErrorResponse,
  Zone,
} from "@/lib/types";
import { toJSON, toCSV, toMarkdown, downloadBlob } from "@/lib/exporters";
import { PriceChart } from "@/components/PriceChart";

const SUFFIX_OPTIONS = [
  { value: "none", label: "自動 / 美股（無後綴）" },
  { value: ".HK", label: ".HK — 香港交易所" },
  { value: ".T", label: ".T — 東京證券交易所" },
  { value: ".SS", label: ".SS — 上海證券交易所" },
  { value: ".SZ", label: ".SZ — 深圳證券交易所" },
  { value: ".TW", label: ".TW — 台灣證券交易所" },
  { value: ".TWO", label: ".TWO — 台灣櫃買中心" },
  { value: ".L", label: ".L — 倫敦證券交易所" },
  { value: ".KS", label: ".KS — 韓國交易所" },
];

function isAmbiguous(x: any): x is AmbiguousResponse {
  return x && x.ambiguous === true;
}
function isError(x: any): x is ErrorResponse {
  return x && typeof x.error === "string";
}

const strengthColor: Record<string, string> = {
  強: "bg-primary/20 text-primary border-primary/40",
  中: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  弱: "bg-muted text-muted-foreground border-border",
};

export default function Home() {
  const [ticker, setTicker] = useState("");
  const [suffix, setSuffix] = useState("none");
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [ambiguous, setAmbiguous] = useState<AmbiguousResponse | null>(null);
  const [errorInfo, setErrorInfo] = useState<ErrorResponse | null>(null);

  const mutation = useMutation({
    mutationFn: async (payload: { ticker: string; suffix: string; force: boolean }) => {
      const res = await apiRequest("POST", "/api/analyze", {
        ticker: payload.ticker,
        suffix: payload.suffix === "none" ? "" : payload.suffix,
        force: payload.force,
      });
      return (await res.json()) as AnalyzeResult | AmbiguousResponse | ErrorResponse;
    },
    onSuccess: (data) => {
      setResult(null);
      setAmbiguous(null);
      setErrorInfo(null);
      if (isAmbiguous(data)) setAmbiguous(data);
      else if (isError(data)) setErrorInfo(data);
      else setResult(data as AnalyzeResult);
    },
    onError: (err: any) => {
      setResult(null);
      setAmbiguous(null);
      setErrorInfo({ error: "network", message: `請求失敗：${err?.message ?? "未知錯誤"}` });
    },
  });

  const runAnalyze = (force = false) => {
    if (!ticker.trim()) return;
    mutation.mutate({ ticker: ticker.trim(), suffix, force });
  };

  const cur = (v: number | null | undefined) => {
    if (v === null || v === undefined) return "N/A";
    const c = result?.status.currency ?? "";
    return `${c} ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold tracking-tight" data-testid="text-app-title">
              支撐阻力技術分析
            </h1>
            <p className="text-xs text-muted-foreground">
              Yahoo Finance 日線 OHLCV · 多方法共振 · 教育用途
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* 輸入區 */}
        <Card className="p-5">
          <div className="grid gap-4 md:grid-cols-[1fr_1.2fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="ticker-input" className="text-xs">股票代號</Label>
              <Input
                id="ticker-input"
                data-testid="input-ticker"
                placeholder="例如 AAPL、0700.HK、2330.TW"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runAnalyze(false)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="suffix-select" className="text-xs">
                交易所後綴（若代號有模糊性請指定）
              </Label>
              <Select value={suffix} onValueChange={setSuffix}>
                <SelectTrigger id="suffix-select" data-testid="select-suffix">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUFFIX_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} data-testid={`option-${o.value}`}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => runAnalyze(false)}
              disabled={mutation.isPending || !ticker.trim()}
              data-testid="button-analyze"
              className="h-10"
            >
              <Search className="mr-2 h-4 w-4" />
              {mutation.isPending ? "分析中…" : "開始分析"}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            純數字代號（如 0700、600519）通常需要指定交易所後綴：港股 .HK、日股 .T、滬股 .SS、深股 .SZ、台股 .TW。
          </p>
        </Card>

        {/* 模糊性提示 */}
        {ambiguous && (
          <Card className="p-5 border-amber-500/40 bg-amber-500/5" data-testid="panel-ambiguous">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
              <div className="space-y-3 w-full">
                <p className="text-sm font-medium">{ambiguous.message}</p>
                <div className="flex flex-wrap gap-2">
                  {ambiguous.hints.map((h) => (
                    <Button
                      key={h.suffix}
                      variant="outline"
                      size="sm"
                      data-testid={`button-suffix-${h.suffix}`}
                      onClick={() => {
                        setSuffix(h.suffix);
                        mutation.mutate({ ticker: ticker.trim(), suffix: h.suffix, force: true });
                      }}
                    >
                      {h.suffix} · {h.market}
                    </Button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="button-force-analyze"
                  onClick={() => runAnalyze(true)}
                >
                  仍以「{ambiguous.ticker}」直接分析
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* 錯誤 / 資料不足 */}
        {errorInfo && (
          <Card className="p-5 border-destructive/40 bg-destructive/5" data-testid="panel-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
              <div className="space-y-2">
                <p className="text-sm font-medium" data-testid="text-error-message">
                  {errorInfo.message}
                </p>
                {errorInfo.detail && (
                  <p className="text-xs text-muted-foreground font-mono">{errorInfo.detail}</p>
                )}
                {errorInfo.hints && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {errorInfo.hints.map((h) => (
                      <Badge key={h.suffix} variant="outline" className="font-mono">
                        {h.suffix} {h.market}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* 載入骨架 */}
        {mutation.isPending && !result && (
          <Card className="p-6 space-y-3" data-testid="panel-loading">
            <div className="h-6 w-1/3 bg-muted rounded animate-pulse" />
            <div className="h-4 w-2/3 bg-muted rounded animate-pulse" />
            <div className="h-40 w-full bg-muted rounded animate-pulse" />
          </Card>
        )}

        {/* 結果 */}
        {result && <ResultView result={result} cur={cur} />}

        {!result && !mutation.isPending && !ambiguous && !errorInfo && <EmptyState />}
      </main>

      <footer className="border-t border-border mt-10">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs text-muted-foreground space-y-1">
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

function ResultView({
  result,
  cur,
}: {
  result: AnalyzeResult;
  cur: (v: number | null | undefined) => string;
}) {
  const s = result.status;
  const i = result.indicators;

  const exportReport = (type: "json" | "csv" | "md") => {
    const base = `${s.ticker}_支撐阻力分析`;
    if (type === "json") downloadBlob(toJSON(result), `${base}.json`, "application/json");
    if (type === "csv") downloadBlob(toCSV(result), `${base}.csv`, "text/csv;charset=utf-8");
    if (type === "md") downloadBlob(toMarkdown(result), `${base}.md`, "text/markdown;charset=utf-8");
  };

  return (
    <div className="space-y-6" data-testid="panel-result">
      {/* 標題 + 匯出 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight" data-testid="text-result-title">
          {s.companyName} <span className="text-muted-foreground font-mono text-base">({s.ticker})</span> 支撐阻力分析
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => exportReport("md")} data-testid="button-export-md">
            <Download className="mr-1.5 h-3.5 w-3.5" /> Markdown
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportReport("csv")} data-testid="button-export-csv">
            <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportReport("json")} data-testid="button-export-json">
            <Download className="mr-1.5 h-3.5 w-3.5" /> JSON
          </Button>
        </div>
      </div>

      {/* 資料狀態 */}
      <Card className="p-5">
        <SectionTitle icon={<Info className="h-4 w-4" />}>資料狀態</SectionTitle>
        <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <StatusItem label="公司名稱" value={s.companyName} testid="text-company" />
          <StatusItem label="股票代號" value={s.ticker} mono testid="text-ticker" />
          <StatusItem label="市場/交易所" value={s.exchange} testid="text-exchange" />
          <StatusItem
            label="目前價格（最後收盤）"
            value={cur(s.currentPrice)}
            highlight
            mono
            testid="text-price"
          />
          <StatusItem label="資料時間點" value={s.dataAsOf ?? "N/A"} mono testid="text-asof" />
          <StatusItem label="資料週期" value={s.period} testid="text-period" />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3 text-xs">
          <ListBlock title="可用資料" items={s.available} tone="ok" />
          <ListBlock title="缺失資料" items={s.missing} tone="warn" />
          <ListBlock title="分析限制" items={s.limitations} tone="muted" />
        </div>
      </Card>

      {/* 指標總覽 */}
      <Card className="p-5">
        <SectionTitle icon={<Activity className="h-4 w-4" />}>指標總覽</SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            ["MA20", i.ma20], ["MA50", i.ma50], ["MA200", i.ma200], ["ATR14", i.atr14],
            ["樞紐點", i.pivot], ["R1", i.r1], ["R2", i.r2], ["S1", i.s1], ["S2", i.s2],
            ["近1月高", i.high1m], ["近1月低", i.low1m], ["近3月高", i.high3m],
            ["近3月低", i.low3m], ["近1年高", i.high1y], ["近1年低", i.low1y],
            ["Fib 38.2%", i.fib382], ["Fib 50%", i.fib500], ["Fib 61.8%", i.fib618],
            ["Cam H3", i.camH3], ["Cam H4", i.camH4], ["Cam L3", i.camL3], ["Cam L4", i.camL4],
          ].map(([label, val]) => (
            <div
              key={label as string}
              className="rounded-md border border-border bg-background/50 px-3 py-2"
              data-testid={`metric-${label}`}
            >
              <div className="text-[11px] text-muted-foreground">{label as string}</div>
              <div className="font-mono text-sm tabular-nums">
                {val === null ? <span className="text-muted-foreground">N/A</span> : (val as number).toFixed(2)}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          區間半寬 = max(ATR14 × 0.2, 價格 × 0.4%) = {i.zoneHalfWidth ?? "N/A"}。樞紐點以最後一個交易日 H/L/C 計算。
        </p>
      </Card>

      {/* 價格圖與關卡 */}
      <Card className="p-5">
        <SectionTitle icon={<Activity className="h-4 w-4" />}>近一年價格與關卡</SectionTitle>
        <PriceChart
          candles={result.candles}
          resistance={result.resistanceZones}
          support={result.supportZones}
          price={s.currentPrice}
        />
      </Card>

      {/* 阻力區 */}
      <Card className="p-5">
        <SectionTitle icon={<TrendingUp className="h-4 w-4 text-destructive" />}>阻力區（由近到遠）</SectionTitle>
        <ZoneTable zones={result.resistanceZones} cur={cur} kind="resistance" emptyMsg="上方無足夠資料形成阻力區（N/A）" />
      </Card>

      {/* 支撐區 */}
      <Card className="p-5">
        <SectionTitle icon={<TrendingDown className="h-4 w-4 text-primary" />}>支撐區（由近到遠）</SectionTitle>
        <ZoneTable zones={result.supportZones} cur={cur} kind="support" emptyMsg="下方無足夠資料形成支撐區（N/A）" />
      </Card>

      {/* 共振關卡 */}
      <Card className="p-5">
        <SectionTitle icon={<Layers className="h-4 w-4" />}>共振關卡</SectionTitle>
        {result.confluenceZones.length ? (
          <div className="space-y-3">
            {result.confluenceZones.map((z, idx) => (
              <div
                key={idx}
                className="rounded-md border border-border bg-background/50 p-3 text-sm"
                data-testid={`confluence-${idx}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-medium tabular-nums">
                    {cur(z.low)} ~ {cur(z.high)}
                  </span>
                  <Badge variant="outline" className={strengthColor[z.strength]}>
                    強度 {z.strength}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  重疊方法：{z.methods.join("、")}
                </p>
                <p className="text-xs text-muted-foreground">
                  為何重要：{z.methods.length} 種方法在 1% 內重疊，關卡有效性較高。
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="text-no-confluence">
            無明確共振關卡（沒有兩種以上方法在 1% 範圍內重疊）。
          </p>
        )}
      </Card>

      {/* 情境 */}
      <div className="grid gap-6 md:grid-cols-2">
        <ScenarioCard title="短線情境（1-5 日）" data={result.shortTerm} testid="scenario-short" />
        <ScenarioCard title="中線情境（1-3 個月）" data={result.midTerm} testid="scenario-mid" />
      </div>

      {/* 簡要解讀 */}
      <Card className="p-5">
        <SectionTitle icon={<Info className="h-4 w-4" />}>簡要解讀</SectionTitle>
        <ol className="space-y-2.5 text-sm list-decimal list-inside" data-testid="list-interpretation">
          <li><span className="text-muted-foreground">當前價格最接近的支撐與阻力：</span>{result.interpretation.nearest}</li>
          <li><span className="text-muted-foreground">哪個區域最強：</span>{result.interpretation.strongest}</li>
          <li><span className="text-muted-foreground">最值得留意的突破/跌破條件：</span>{result.interpretation.breakoutCondition}</li>
          <li><span className="text-muted-foreground">哪個訊號可能代表假突破：</span>{result.interpretation.fakeoutSignal}</li>
          <li><span className="text-muted-foreground">本分析的主要限制：</span>{result.interpretation.limitation}</li>
        </ol>
      </Card>

      {/* 風險聲明 */}
      <Card className="p-5 border-amber-500/30 bg-amber-500/5">
        <p className="text-sm" data-testid="text-risk-statement">
          <strong>風險聲明：</strong>以上內容僅為技術分析與教育用途，非投資建議。
        </p>
      </Card>
    </div>
  );
}

function ZoneTable({
  zones,
  cur,
  kind,
  emptyMsg,
}: {
  zones: Zone[];
  cur: (v: number | null | undefined) => string;
  kind: string;
  emptyMsg: string;
}) {
  if (!zones.length) {
    return <p className="text-sm text-muted-foreground" data-testid={`text-empty-${kind}`}>{emptyMsg}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>區間</TableHead>
            <TableHead>強度</TableHead>
            <TableHead>驗證方法</TableHead>
            <TableHead>適用週期</TableHead>
            <TableHead>備註</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {zones.map((z, idx) => (
            <TableRow key={idx} data-testid={`row-${kind}-${idx}`}>
              <TableCell className="font-mono tabular-nums whitespace-nowrap">
                {cur(z.low)} ~ {cur(z.high)}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={strengthColor[z.strength]}>{z.strength}</Badge>
              </TableCell>
              <TableCell className="text-xs max-w-xs">{z.methods.join("、")}</TableCell>
              <TableCell className="text-xs whitespace-nowrap">{z.timeframe}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {z.isConfluence && <Layers className="inline h-3 w-3 mr-1 text-primary" />}
                {z.note}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ScenarioCard({
  title,
  data,
  testid,
}: {
  title: string;
  data: { bull: string; bear: string; neutral: string };
  testid: string;
}) {
  return (
    <Card className="p-5" data-testid={testid}>
      <SectionTitle icon={<Activity className="h-4 w-4" />}>{title}</SectionTitle>
      <div className="space-y-3 text-sm">
        <ScenarioRow icon={<TrendingUp className="h-4 w-4 text-primary" />} label="偏多情境" text={data.bull} />
        <ScenarioRow icon={<TrendingDown className="h-4 w-4 text-destructive" />} label="偏空情境" text={data.bear} />
        <ScenarioRow icon={<Minus className="h-4 w-4 text-muted-foreground" />} label="中性情境" text={data.neutral} />
      </div>
    </Card>
  );
}

function ScenarioRow({ icon, label, text }: { icon: React.ReactNode; label: string; text: string }) {
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div>
        <div className="font-medium text-xs">{label}</div>
        <p className="text-muted-foreground leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

function SectionTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold mb-4 pb-2 border-b border-border">
      {icon}
      {children}
    </h3>
  );
}

function StatusItem({
  label,
  value,
  highlight,
  mono,
  testid,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  mono?: boolean;
  testid?: string;
}) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={`${mono ? "font-mono tabular-nums" : ""} ${
          highlight ? "text-primary font-semibold text-base" : "text-sm"
        }`}
        data-testid={testid}
      >
        {value}
      </div>
    </div>
  );
}

function ListBlock({ title, items, tone }: { title: string; items: string[]; tone: "ok" | "warn" | "muted" }) {
  const dot = tone === "ok" ? "bg-primary" : tone === "warn" ? "bg-amber-500" : "bg-muted-foreground";
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="font-medium mb-1.5">{title}</div>
      <ul className="space-y-1">
        {items.map((it, idx) => (
          <li key={idx} className="flex gap-1.5 text-muted-foreground leading-relaxed">
            <span className={`mt-1.5 h-1 w-1 rounded-full shrink-0 ${dot}`} />
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="p-10 text-center" data-testid="panel-empty">
      <Logo className="mx-auto mb-4 opacity-60" size={44} />
      <h2 className="text-base font-medium">輸入股票代號開始技術分析</h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
        本工具抓取近一年日線 OHLCV，計算移動平均、ATR、樞紐點、Fibonacci、Camarilla、盤整平台與歷史轉折，
        並以區間形式呈現支撐與阻力關卡，標記多方法共振。
      </p>
      <div className="mt-4 flex flex-wrap gap-2 justify-center text-xs">
        {["AAPL", "TSLA", "0700.HK", "2330.TW", "7203.T"].map((t) => (
          <Badge key={t} variant="outline" className="font-mono">{t}</Badge>
        ))}
      </div>
    </Card>
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
      aria-label="支撐阻力分析標誌"
    >
      <rect x="1" y="1" width="30" height="30" rx="7" stroke="currentColor" className="text-primary" strokeWidth="1.5" />
      <path d="M6 20 L12 14 L17 18 L26 8" stroke="currentColor" className="text-primary" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="6" y1="24" x2="26" y2="24" stroke="currentColor" className="text-primary/40" strokeWidth="1.5" strokeDasharray="2 2" />
      <line x1="6" y1="11" x2="26" y2="11" stroke="currentColor" className="text-destructive/50" strokeWidth="1.5" strokeDasharray="2 2" />
    </svg>
  );
}
