import React, { useState, useMemo, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Layout } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  RefreshCw,
  ArrowUpDown,
  Clock,
  TrendingUp,
  TrendingDown,
  Info,
} from "lucide-react";

// Dynamic import for nyse-holidays (client-side)
async function getNYSEHolidays(year: number): Promise<Set<string>> {
  try {
    const module = await import("nyse-holidays");
    const holidays = module.getHolidays(year);
    return new Set(holidays.map((h: any) => h.date.toISOString().split("T")[0]));
  } catch (e) {
    console.error("[SpreadScan] Failed to load nyse-holidays:", e);
    return new Set();
  }
}

// 檢查是否為美股假日
async function isUSHoliday(date: Date): Promise<boolean> {
  const year = date.getFullYear();
  const holidays = await getNYSEHolidays(year);
  const dateStr = date.toISOString().split("T")[0];
  return holidays.has(dateStr);
}

// 檢查是否在美股交易時間內
async function isInUSMarketHours(): Promise<boolean> {
  const now = new Date();
  
  const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = etDate.getDay();
  const hours = etDate.getHours();
  const minutes = etDate.getMinutes();
  const currentTimeMinutes = hours * 60 + minutes;
  
  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;
  
  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = currentTimeMinutes >= marketOpen && currentTimeMinutes < marketClose;
  const isHoliday = await isUSHoliday(etDate);
  
  return isWeekday && isMarketHours && !isHoliday;
}

// 檢查今天是否為交易日
async function isTradeDay(): Promise<boolean> {
  const now = new Date();
  const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = etDate.getDay();
  const isHoliday = await isUSHoliday(etDate);
  return day >= 1 && day <= 5 && !isHoliday;
}

// Types matching the backend
interface RankedCandidate {
  direction: "bear_call" | "bull_put";
  symbol: string;
  companyName: string;
  currentPrice: number;
  shortStrike: number;
  longStrike: number;
  expiration: string;
  netCredit: number;
  maxLoss: number;
  roc: number;
  breakevenPrice: number;
  breakevenBufferPct: number;
  score: number;
  ivRank: number | null;
  daysToEarnings: number | null;
}

interface DualDirectionResult {
  symbol: string;
  companyName: string;
  bearCall: RankedCandidate | null;
  bullPut: RankedCandidate | null;
  bearCallRejectReason: string | null;
  bullPutRejectReason: string | null;
}

interface SpreadOpportunityResponse {
  bestBearCalls: RankedCandidate[];
  bestBullPuts: RankedCandidate[];
  allResults: DualDirectionResult[];
  lastUpdated: string;
  marketStatus: "open" | "closed";
  optionChainCallCount: number;
}

// Tooltip explanations
const TOOLTIPS = {
  ROC: "Return on Credit = 權利金 / 最大損失。這個數值代表每承擔 1 元潛在損失能獲得的回報，數字越高越好。篩選門檻：25%（即權利金至少覆蓋最大損失的 25%）",
  breakevenBuffer: "損益平衡點緩衝 = 股價偏離損益平衡點的百分比。這個數值代表股價從現在到履約日可以向不利方向移動多少而不会亏损，數字越高越安全。篩選門檻：6%",
  ivRank: "IV Rank = 歷史波動率排名（0-100）。數字越高代表目前波動率相對過去處於高點，選擇權權利金較好。Bear Call 門檻：30，Bull Put 門檻：35",
  delta: "Delta 選擇權風險指標，代表股價變動 1% 時選擇權價格的變動百分比。短檔選擇權的 Delta 在 0.12-0.20 之間，平衡風險與收益。",
  score: "綜合評分 = ROC(40%) + 損益平衡緩衝(30%) + IV Rank(30%)。分數越高代表這筆價差機會越優質。",
};

export default function SpreadScanPage() {
  const [search, setSearch] = useState("");
  
  // 交易時間狀態
  const [isMarketHours, setIsMarketHours] = useState(false);
  const [isTodayTradeDay, setIsTodayTradeDay] = useState(false);

  // 檢查市場狀態
  useEffect(() => {
    (async () => {
      const marketOpen = await isInUSMarketHours();
      const tradeDay = await isTradeDay();
      setIsMarketHours(marketOpen);
      setIsTodayTradeDay(tradeDay);
      console.log(`[SpreadScan] Market status: isTradeDay=${tradeDay}, isInMarketHours=${marketOpen}`);
    })();
  }, []);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/spread-opportunities");
      return (await res.json()) as SpreadOpportunityResponse;
    },
  });

  // Auto-retry if data is empty
  useEffect(() => {
    if (mutation.isSuccess && 
        mutation.data && 
        mutation.data.bestBearCalls?.length === 0 &&
        mutation.data.bestBullPuts?.length === 0 &&
        mutation.failureCount < 2) {
      const timer = setTimeout(() => {
        console.log("[SpreadScan] Empty data received, retrying...");
        mutation.mutate();
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [mutation.isSuccess, mutation.data, mutation.failureCount]);

  const data = mutation.data;
  
  const bestBearCalls = data?.bestBearCalls || [];
  const bestBullPuts = data?.bestBullPuts || [];

  // Filter and sort
  const filteredBearCalls = useMemo(() => {
    let result = [...bestBearCalls];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.symbol.toLowerCase().includes(s) ||
          r.companyName.toLowerCase().includes(s)
      );
    }
    return result;
  }, [bestBearCalls, search]);

  const filteredBullPuts = useMemo(() => {
    let result = [...bestBullPuts];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.symbol.toLowerCase().includes(s) ||
          r.companyName.toLowerCase().includes(s)
      );
    }
    return result;
  }, [bestBullPuts, search]);

  // Helper functions
  const formatPrice = (p: number) => "$" + p.toFixed(2);
  
  const formatPercent = (v: number) => v.toFixed(1) + "%";
  
  const formatStrike = (short: number, long: number) => `${short} / ${long}`;

  // Table column renderer
  function CandidateRow({ candidate }: { candidate: RankedCandidate }) {
    const isBearCall = candidate.direction === "bear_call";
    const bgClass = isBearCall ? "bg-green-500/5" : "bg-red-500/5";
    const badgeClass = isBearCall 
      ? "bg-green-500/20 text-green-500 border-green-500/40" 
      : "bg-red-500/20 text-red-500 border-red-500/40";
    
    return (
      <TableRow className={bgClass}>
        <TableCell className="font-mono font-medium">
          {candidate.symbol}
        </TableCell>
        <TableCell className="max-w-[180px] truncate">
          {candidate.companyName}
        </TableCell>
        <TableCell className="font-mono text-right">
          {formatStrike(candidate.shortStrike, candidate.longStrike)}
        </TableCell>
        <TableCell className="font-mono text-right">
          {candidate.expiration}
        </TableCell>
        <TableCell className="text-right">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                {formatPercent(candidate.roc)}
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs max-w-[250px]">{TOOLTIPS.ROC}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
        <TableCell className="text-right">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                {formatPercent(candidate.breakevenBufferPct)}
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs max-w-[250px]">{TOOLTIPS.breakevenBuffer}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
        <TableCell className="text-right">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                {candidate.ivRank ?? "N/A"}
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs max-w-[250px]">{TOOLTIPS.ivRank}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
        <TableCell className="text-right font-mono">
          {candidate.netCredit.toFixed(2)}
        </TableCell>
        <TableCell className="text-right font-mono">
          {candidate.maxLoss.toFixed(2)}
        </TableCell>
        <TableCell className="text-right font-bold">
          {candidate.score}
        </TableCell>
        <TableCell className="text-right text-xs">
          {candidate.daysToEarnings !== null ? (
            <span className={candidate.daysToEarnings <= 3 ? "text-orange-500 font-medium" : ""}>
              {candidate.daysToEarnings}天
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
      </TableRow>
    );
  }

  // Desktop table
  function DesktopTable({ candidates, direction }: { candidates: RankedCandidate[]; direction: "bear_call" | "bull_put" }) {
    const isBearCall = direction === "bear_call";
    
    return (
      <div className="hidden sm:block overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead className="py-2">代碼</TableHead>
              <TableHead className="py-2">公司名稱</TableHead>
              <TableHead className="text-right py-2">
                履約價 (short/long)
              </TableHead>
              <TableHead className="text-right py-2">到期日</TableHead>
              <TableHead className="text-right py-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                      ROC
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs max-w-[250px]">{TOOLTIPS.ROC}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </TableHead>
              <TableHead className="text-right py-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                      緩衝%
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs max-w-[250px]">{TOOLTIPS.breakevenBuffer}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </TableHead>
              <TableHead className="text-right py-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                      IV Rank
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs max-w-[250px]">{TOOLTIPS.ivRank}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </TableHead>
              <TableHead className="text-right py-2">淨收權利金</TableHead>
              <TableHead className="text-right py-2">最大損失</TableHead>
              <TableHead className="text-right py-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                      評分
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs max-w-[250px]">{TOOLTIPS.score}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </TableHead>
              <TableHead className="text-right py-2">距財報</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {candidates.map((candidate) => (
              <CandidateRow key={candidate.symbol} candidate={candidate} />
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  // Mobile card
  function MobileCard({ candidate }: { candidate: RankedCandidate }) {
    const isBearCall = candidate.direction === "bear_call";
    const bgClass = isBearCall ? "bg-green-500/5" : "bg-red-500/5";
    const badgeClass = isBearCall 
      ? "bg-green-500/20 text-green-500" 
      : "bg-red-500/20 text-red-500";
    
    return (
      <Card className={`p-3 ${bgClass}`}>
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className="font-mono font-semibold text-base">{candidate.symbol}</div>
            <div className="text-sm text-muted-foreground truncate">{candidate.companyName}</div>
          </div>
          <Badge variant="outline" className={`${badgeClass} text-xs`}>
            {isBearCall ? "Bear Call" : "Bull Put"}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">履約價</div>
            <div className="font-mono">{candidate.shortStrike} / {candidate.longStrike}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">到期日</div>
            <div className="font-mono">{candidate.expiration}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">ROC</div>
            <div className="font-mono">{formatPercent(candidate.roc)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">緩衝%</div>
            <div className="font-mono">{formatPercent(candidate.breakevenBufferPct)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">IV Rank</div>
            <div className="font-mono">{candidate.ivRank ?? "N/A"}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">評分</div>
            <div className="font-mono font-bold">{candidate.score}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">淨收權利金</div>
            <div className="font-mono">${candidate.netCredit.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">最大損失</div>
            <div className="font-mono">${candidate.maxLoss.toFixed(2)}</div>
          </div>
        </div>

        {candidate.daysToEarnings !== null && candidate.daysToEarnings <= 3 && (
          <div className="mt-2 pt-2 border-t border-border text-xs text-orange-500">
            ⚠️ 財報將在 {candidate.daysToEarnings} 天後發布
          </div>
        )}
      </Card>
    );
  }

  function MobileList({ candidates }: { candidates: RankedCandidate[] }) {
    return (
      <div className="sm:hidden space-y-2">
        {candidates.map((candidate) => (
          <MobileCard key={candidate.symbol} candidate={candidate} />
        ))}
      </div>
    );
  }

  return (
    <Layout title="價差機會掃描" subtitle="Bear Call 與 Bull Put 最佳候選排名">
      <main className="mx-auto max-w-6xl px-2 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        {/* 控制區 */}
        <Card className="p-3 sm:p-4 space-y-3">
          {/* 重新整理按鈕 */}
          <div className="flex flex-wrap gap-2 items-center">
            <Button
              variant="outline"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="min-h-[44px]"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${mutation.isPending ? "animate-spin" : ""}`} />
              重新整理
            </Button>
            
            {/* 市場狀態 */}
            {data?.marketStatus && (
              <Badge variant="outline" className={data.marketStatus === "open" ? "bg-green-500/20 text-green-500 border-green-500/40" : "bg-amber-500/20 text-amber-500 border-amber-500/40"}>
                <Clock className="w-3 h-3 mr-1" />
                {data.marketStatus === "open" ? "盤中" : "盤後"}
              </Badge>
            )}
            
            {/* Option chain 呼叫次數 */}
            {data?.optionChainCallCount !== undefined && (
              <span className="text-xs text-muted-foreground ml-2">
                API呼叫: {data.optionChainCallCount} 次
              </span>
            )}
          </div>

          {/* 搜尋 */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="搜尋代碼或公司名稱..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 min-h-[44px]"
            />
          </div>

          {/* 資料更新時間 */}
          {data?.lastUpdated && (
            <div className="text-xs text-muted-foreground">
              資料更新時間：{new Date(data.lastUpdated).toLocaleString("zh-TW")}
            </div>
          )}
        </Card>

        {/* 載入中 */}
        {mutation.isPending && (
          <Card className="p-8 text-center">
            <RefreshCw className="w-8 h-8 mx-auto animate-spin mb-2" />
            <p className="text-muted-foreground">正在掃描價差機會...</p>
            <p className="text-xs text-muted-foreground mt-1">這可能需要幾分鐘</p>
          </Card>
        )}

        {/* 錯誤 */}
        {mutation.isError && (
          <Card className="p-6 border-destructive/40 bg-destructive/5">
            <p className="text-destructive">載入失敗：{(mutation.error as any)?.message}</p>
            <Button variant="outline" className="mt-2" onClick={() => mutation.mutate()}>
              重試
            </Button>
          </Card>
        )}

        {/* 結果 */}
        {!mutation.isPending && !mutation.isError && (
          <Tabs defaultValue="bearCall" className="w-full">
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="bearCall" className="flex items-center gap-2">
                <TrendingDown className="w-4 h-4" />
                Bear Call
                <Badge variant="secondary" className="ml-1">{filteredBearCalls.length}</Badge>
              </TabsTrigger>
              <TabsTrigger value="bullPut" className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Bull Put
                <Badge variant="secondary" className="ml-1">{filteredBullPuts.length}</Badge>
              </TabsTrigger>
            </TabsList>

            {/* Bear Call Tab */}
            <TabsContent value="bearCall" className="mt-4">
              {filteredBearCalls.length === 0 ? (
                <Card className="p-6 text-center">
                  <p className="text-muted-foreground">
                    {search ? "沒有符合搜尋條件的 Bear Call 機會" : "目前沒有符合條件的 Bear Call 候選"}
                  </p>
                </Card>
              ) : (
                <>
                  <div className="hidden sm:block mb-2 text-sm text-muted-foreground">
                    顯示 {filteredBearCalls.length} 個 Bear Call 候選 · 參數: Delta 0.12-0.20, ROC ≥25%, 緩衝 ≥6%, IV Rank ≥30
                  </div>
                  <DesktopTable candidates={filteredBearCalls} direction="bear_call" />
                  <MobileList candidates={filteredBearCalls} />
                </>
              )}
            </TabsContent>

            {/* Bull Put Tab */}
            <TabsContent value="bullPut" className="mt-4">
              {filteredBullPuts.length === 0 ? (
                <Card className="p-6 text-center">
                  <p className="text-muted-foreground">
                    {search ? "沒有符合搜尋條件的 Bull Put 機會" : "目前沒有符合條件的 Bull Put 候選"}
                  </p>
                </Card>
              ) : (
                <>
                  <div className="hidden sm:block mb-2 text-sm text-muted-foreground">
                    顯示 {filteredBullPuts.length} 個 Bull Put 候選 · 參數: Delta 0.12-0.20, ROC ≥25%, 緩衝 ≥6%, IV Rank ≥35
                  </div>
                  <DesktopTable candidates={filteredBullPuts} direction="bull_put" />
                  <MobileList candidates={filteredBullPuts} />
                </>
              )}
            </TabsContent>
          </Tabs>
        )}

        {/* 風險警語 */}
        <Card className="p-3 bg-amber-500/10 border-amber-500/30">
          <p className="text-xs text-amber-600 dark:text-amber-400">
            ⚠️ <strong>風險提示：</strong>此頁面數據來自 Yahoo Finance 免費報價，與真實券商報價可能存在差距。建議下單前核對即時券商報價，確認 delta、權利金等數值無誤。深度價外合約（履約價與現價距離超過 20%）及 bid-ask 價差過寬的合約已被過濾，但仍建議謹慎評估。
          </p>
        </Card>
      </main>
    </Layout>
  );
}