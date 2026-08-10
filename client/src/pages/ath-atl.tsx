import { useState, useMemo, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
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
import {
  TrendingUp,
  TrendingDown,
  Search,
  RefreshCw,
  ArrowUpDown,
  Volume2,
  Calendar,
  Clock,
  Info,
} from "lucide-react";

// Dynamic import for nyse-holidays (client-side)
async function getNYSEHolidays(year: number): Promise<Set<string>> {
  try {
    const module = await import("nyse-holidays");
    const holidays = module.getHolidays(year);
    return new Set(holidays.map((h: any) => h.date.toISOString().split("T")[0]));
  } catch (e) {
    console.error("[ATH-ATL] Failed to load nyse-holidays:", e);
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

// 檢查是否在美股交易時間內 (美東時間 9:30 AM - 4:00 PM，週一至週五，且非假日)
async function isInUSMarketHours(): Promise<boolean> {
  const now = new Date();
  
  // 轉換為美東時間
  const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = etDate.getDay();
  const hours = etDate.getHours();
  const minutes = etDate.getMinutes();
  const currentTimeMinutes = hours * 60 + minutes;
  
  // 市場開放時間: 9:30 AM - 4:00 PM ET (570 - 960 分鐘)
  const marketOpen = 9 * 60 + 30; // 9:30
  const marketClose = 16 * 60; // 16:00 (4:00 PM)
  
  // 檢查是否為平日 (週一=1, 週五=5)
  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = currentTimeMinutes >= marketOpen && currentTimeMinutes < marketClose;
  const isHoliday = await isUSHoliday(etDate);
  
  return isWeekday && isMarketHours && !isHoliday;
}

// 檢查今天是否為交易日 (平日 + 非假日)
async function isTradeDay(): Promise<boolean> {
  const now = new Date();
  const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = etDate.getDay();
  const isHoliday = await isUSHoliday(etDate);
  return day >= 1 && day <= 5 && !isHoliday; // 週一至週五且非假日
}

interface ATHATLRecord {
  symbol: string;
  company_name: string;
  exchange: string;
  last_close: number;
  ath_price: number | null;
  ath_date: string | null;
  atl_price: number | null;
  atl_date: string | null;
  change_pct: number;
  volume: number;
  list_type: "ATH" | "ATL" | "52W_ATH" | "52W_ATL";
  next_earnings_date: string | null;
  days_to_earnings: number | null;
  // Valuation fields
  forwardPE: number | null;
  pegNearTerm: number | null;
  pegLongTerm: number | null;
  nearTermGrowthPct: number | null;
  longTermGrowthPct: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  peBookHistoricalPercentile: number | null;
  dividendYield: number | null;
  sectorCategory: string;
  primaryValuationMetric: string;
  isProfitable: boolean | null;
  sector: string | null;
  industry: string | null;
  // Peer comparison fields
  peerAvgForwardPE: number | null;
  peerCount: number;
}

interface ATHATLResponse {
  ath: ATHATLRecord[];
  atl: ATHATLRecord[];
  ath52w: ATHATLRecord[];
  atl52w: ATHATLRecord[];
  lastUpdated: string;
  lastUpdated52w: string;
}

type TabType = "ath" | "atl" | "52w_ath" | "52w_atl";

type SortField = "change_pct" | "volume" | "ath_date" | "atl_date";
type SortOrder = "asc" | "desc";

const EXCHANGES = ["all", "NYSE", "NASDAQ", "AMEX"] as const;

// Sector category grouping constants
const CATEGORY_ORDER: string[] = [
  "growth_consumer",
  "mature_stable",
  "growth_software",
  "cyclical",
  "asset_heavy",
  "early_stage_loss",
  "unclassified",
];

const CATEGORY_LABELS: Record<string, string> = {
  growth_consumer: "高成長消費",
  mature_stable: "成熟穩定型",
  growth_software: "高成長軟體",
  cyclical: "週期性行業",
  asset_heavy: "資產密集型",
  early_stage_loss: "早期虧損",
  unclassified: "未分類",
};

export default function ATHATLPage() {
  const [activeTab, setActiveTab] = useState<TabType>("ath");
  const [search, setSearch] = useState("");
  const [exchange, setExchange] = useState<string>("all");
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const getDefaultSortField = (tab: TabType): SortField => {
    if (tab === "ath" || tab === "52w_ath") return "ath_date";
    return "atl_date";
  };
  
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [sortField, setSortField] = useState<SortField>("ath_date");

  const toggleCardExpand = (symbol: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) {
        next.delete(symbol);
      } else {
        next.add(symbol);
      }
      return next;
    });
  };
  
  // 根據 activeTab 初始排序欄位
  useEffect(() => {
    if (activeTab === "ath" || activeTab === "52w_ath") {
      setSortField("ath_date");
    } else {
      setSortField("atl_date");
    }
  }, [activeTab]);

  // 交易時間狀態
  const [isMarketHours, setIsMarketHours] = useState(false);
  const [isTodayTradeDay, setIsTodayTradeDay] = useState(false);

  // 檢查市場狀態 (只執行一次)
  useEffect(() => {
    (async () => {
      const marketOpen = await isInUSMarketHours();
      const tradeDay = await isTradeDay();
      setIsMarketHours(marketOpen);
      setIsTodayTradeDay(tradeDay);
      console.log(`[ATH-ATL] Market status: isTradeDay=${tradeDay}, isInMarketHours=${marketOpen}`);
    })();
  }, []);

  const mutation = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams();
      if (exchange !== "all") params.set("exchange", exchange);
      // 只請求當前 tab 需要的資料類型
      const typeMap: Record<TabType, string> = {
        "ath": "ath",
        "atl": "atl",
        "52w_ath": "ath52w",
        "52w_atl": "atl52w",
      };
      params.set("type", typeMap[activeTab]);
      const res = await apiRequest("GET", `/api/ath-atl?${params.toString()}`);
      return (await res.json()) as ATHATLResponse;
    },
  });

  // 使用者切換 tab 時獲取對應資料
  useEffect(() => {
    mutation.mutate();
  }, [activeTab, exchange]);

  // Auto-retry if data is empty (server might be warming cache)
  useEffect(() => {
    const currentData = activeTab === "ath" 
      ? mutation.data?.ath 
      : activeTab === "atl" 
      ? mutation.data?.atl
      : activeTab === "52w_ath" 
      ? mutation.data?.ath52w
      : mutation.data?.atl52w;
      
    if (mutation.isSuccess && 
        mutation.data && 
        (!currentData || currentData.length === 0) &&
        mutation.failureCount < 2) {
      const timer = setTimeout(() => {
        console.log("[ATH-ATL] Empty data received, retrying...");
        mutation.mutate();
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [mutation.isSuccess, mutation.data, mutation.failureCount, activeTab]);

  const data = mutation.data;
  const records = activeTab === "ath" 
    ? data?.ath || [] 
    : activeTab === "atl" 
    ? data?.atl || []
    : activeTab === "52w_ath" 
    ? data?.ath52w || []
    : data?.atl52w || [];

  const filteredAndSorted = useMemo(() => {
    let result = [...records];

    // 搜尋过滤
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.symbol.toLowerCase().includes(s) ||
          r.company_name.toLowerCase().includes(s)
      );
    }

    // 排序
    result.sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortField) {
        case "change_pct":
          aVal = Math.abs(a.change_pct);
          bVal = Math.abs(b.change_pct);
          break;
        case "volume":
          aVal = a.volume;
          bVal = b.volume;
          break;
        case "ath_date":
          aVal = a.ath_date || "";
          bVal = b.ath_date || "";
          break;
        case "atl_date":
          aVal = a.atl_date || "";
          bVal = b.atl_date || "";
          break;
        default:
          return 0;
      }
      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    return result;
  }, [records, search, sortOrder, sortField]);

  // Group records by sector category
  const groupedRecords = useMemo(() => {
    const groups = new Map<string, ATHATLRecord[]>();
    for (const record of filteredAndSorted) {
      const cat = record.sectorCategory || "unclassified";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(record);
    }

    return CATEGORY_ORDER
      .filter((cat) => groups.has(cat) && groups.get(cat)!.length > 0)
      .map((cat) => ({ 
        category: cat, 
        label: CATEGORY_LABELS[cat], 
        records: groups.get(cat)! 
      }));
  }, [filteredAndSorted]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const formatVolume = (v: number) => {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    return v.toLocaleString();
  };

  const formatPrice = (p: number) => "$" + p.toFixed(2);

  const formatDate = (d: string | null) => d || "N/A";

// Helper function to format percentile as semantic description
function formatPercentile(percentile: number | null, metricName: string): string {
  if (percentile === null) return "N/A";
  if (percentile >= 80) return `高於過去3年${percentile}%的時間（相對自己偏貴）`;
  if (percentile >= 60) return `高於過去3年${percentile}%的時間（略偏高）`;
  if (percentile >= 40) return `位於過去3年中間區間（相對正常）`;
  if (percentile >= 20) return `低於過去3年${100 - percentile}%的時間（略偏低）`;
  return `低於過去3年${100 - percentile}%的時間（相對自己便宜）`;
}

// Helper function to format valuation value
function formatValuation(value: number | null, suffix: string = ""): string {
  if (value === null) return "";
  return value.toFixed(2) + suffix;
}

// Get sector category display
function getSectorCategoryDisplay(category: string | undefined): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    mature_stable: { label: "成熟穩定型", color: "text-blue-500" },
    cyclical: { label: "週期性行業", color: "text-orange-500" },
    asset_heavy: { label: "資產密集型", color: "text-yellow-500" },
    growth_consumer: { label: "高成長消費", color: "text-green-500" },
    growth_software: { label: "高成長軟體", color: "text-purple-500" },
    early_stage_loss: { label: "早期虧損", color: "text-gray-500" },
    unclassified: { label: "未分類", color: "text-muted-foreground" },
  };
  return map[category || ""] || map.unclassified;
}

// Helper function to determine if PEG should be shown for this sector category
function shouldShowPEG(category: string): boolean {
  return category !== "early_stage_loss" && category !== "growth_software" && category !== "cyclical" && category !== "asset_heavy";
}

// Helper function to get PEG display note based on sector category
function getPEGDisplayNote(category: string): string | null {
  if (category === "early_stage_loss" || category === "growth_software") return "此類型不適用";
  if (category === "cyclical" || category === "asset_heavy") return "參考性低";
  return null;
}

// Helper function for percentile badge styling
function getPercentileBadge(percentile: number | null): { text: string; className: string } | null {
  if (percentile === null) return null;
  if (percentile >= 80) return { text: "偏貴", className: "text-orange-500 border-orange-500/40 bg-orange-500/10" };
  if (percentile >= 60) return { text: "略高", className: "text-yellow-500 border-yellow-500/40 bg-yellow-500/10" };
  if (percentile >= 40) return { text: "正常", className: "text-muted-foreground border-border" };
  if (percentile >= 20) return { text: "略低", className: "text-blue-400 border-blue-400/40 bg-blue-400/10" };
  return { text: "偏低", className: "text-green-500 border-green-500/40 bg-green-500/10" };
}

  const getExchangeBadge = (ex: string) => {
    const colors: Record<string, string> = {
      NYSE: "bg-blue-500/20 text-blue-500 border-blue-500/40",
      NASDAQ: "bg-purple-500/20 text-purple-500 border-purple-500/40",
      AMEX: "bg-green-500/20 text-green-500 border-green-500/40",
    };
    return colors[ex] || "";
  };

  // 追蹤當前展開的說明框（確保同卡片同時只展開一個）
  const [infoExpanded, setInfoExpanded] = useState<string | null>(null);

  // Metric with clickable info icon for mobile
  function MetricWithInfo({
    label,
    value,
    explanation,
    metricKey,
  }: {
    label: string;
    value: React.ReactNode;
    explanation: string;
    metricKey: string;
  }) {
    const isExpanded = infoExpanded === metricKey;
    
    return (
      <div className="relative">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground text-xs">{label}</span>
          <button
            type="button"
            onClick={() => setInfoExpanded(isExpanded ? null : metricKey)}
            className="text-muted-foreground/60 active:text-muted-foreground p-0.5"
            aria-label={`${label}說明`}
          >
            <Info className="w-3 h-3" />
          </button>
        </div>
        <div className="font-mono text-sm">{value}</div>
        {isExpanded && (
          <div className="absolute z-20 top-full left-0 mt-1 w-56 max-w-[calc(100vw-2rem)] p-2 rounded-md bg-popover border border-border text-xs text-muted-foreground shadow-lg">
            {explanation}
          </div>
        )}
      </div>
    );
  }

  return (
    <Layout title="ATH / ATL Scanner" subtitle="歷史新高/新低 | All-Time High & Low">
      <main className="mx-auto max-w-6xl px-2 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        {/* 控制區 */}
        <Card className="p-3 sm:p-4">
          <div className="flex flex-col gap-3">
            {/* Tab 切換 - 手機版 2x2 網格，桌面版橫向排列 */}
            <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-2 w-full">
              <Button
                variant={activeTab === "ath" ? "default" : "outline"}
                onClick={() => setActiveTab("ath")}
                className={`flex-1 min-h-[44px] text-xs sm:text-sm ${activeTab === "ath" ? "bg-green-600 hover:bg-green-700" : ""}`}
              >
                <TrendingUp className="w-4 h-4 mr-1 flex-shrink-0" />
                <span className="truncate">ATH</span>
              </Button>
              <Button
                variant={activeTab === "atl" ? "default" : "outline"}
                onClick={() => setActiveTab("atl")}
                className={`flex-1 min-h-[44px] text-xs sm:text-sm ${activeTab === "atl" ? "bg-red-600 hover:bg-red-700" : ""}`}
              >
                <TrendingDown className="w-4 h-4 mr-1 flex-shrink-0" />
                <span className="truncate">ATL</span>
              </Button>
              <Button
                variant={activeTab === "52w_ath" ? "default" : "outline"}
                onClick={() => setActiveTab("52w_ath")}
                className={`flex-1 min-h-[44px] text-xs sm:text-sm ${activeTab === "52w_ath" ? "bg-green-600 hover:bg-green-700" : ""}`}
              >
                <TrendingUp className="w-4 h-4 mr-1 flex-shrink-0" />
                <span className="hidden sm:inline">52週新高</span>
                <span className="sm:hidden">52W新高</span>
              </Button>
              <Button
                variant={activeTab === "52w_atl" ? "default" : "outline"}
                onClick={() => setActiveTab("52w_atl")}
                className={`flex-1 min-h-[44px] text-xs sm:text-sm ${activeTab === "52w_atl" ? "bg-red-600 hover:bg-red-700" : ""}`}
              >
                <TrendingDown className="w-4 h-4 mr-1 flex-shrink-0" />
                <span className="hidden sm:inline">52週新低</span>
                <span className="sm:hidden">52W新低</span>
              </Button>
            </div>

            {/* 交易所篩選 + 重新整理按鈕 */}
            <div className="flex flex-wrap gap-2 items-center">
              <select
                value={exchange}
                onChange={(e) => setExchange(e.target.value)}
                className="px-3 py-2 rounded-md border border-border bg-background text-sm min-h-[44px] flex-1 sm:flex-none sm:min-w-[140px]"
              >
                <option value="all">全部交易所</option>
                <option value="NYSE">NYSE</option>
                <option value="NASDAQ">NASDAQ</option>
                <option value="AMEX">AMEX</option>
              </select>
              <Button
                variant="outline"
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending}
                className="min-h-[44px] min-w-[44px]"
              >
                <RefreshCw className={`w-4 h-4 ${mutation.isPending ? "animate-spin" : ""}`} />
                <span className="ml-1 hidden sm:inline">重新整理</span>
              </Button>
            </div>
          </div>

          {/* 搜尋與排序 */}
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 mt-3 sm:mt-4">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="搜尋代碼或公司名稱..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 min-h-[44px]"
              />
            </div>
          </div>

          {/* 排序按鈕 - 手機版換行 */}
          <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-3">
            <Button variant="ghost" size="sm" onClick={() => handleSort("change_pct")} className="min-h-[44px] px-2 sm:px-3 text-xs">
              <ArrowUpDown className="w-3 h-3 mr-1" />
              漲跌幅 {sortField === "change_pct" && (sortOrder === "desc" ? "↓" : "↑")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleSort("volume")} className="min-h-[44px] px-2 sm:px-3 text-xs">
              <Volume2 className="w-3 h-3 mr-1" />
              <span className="hidden sm:inline">成交量</span>
              <span className="sm:hidden">量</span>
              {sortField === "volume" && (sortOrder === "desc" ? "↓" : "↑")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleSort(activeTab === "ath" || activeTab === "52w_ath" ? "ath_date" : "atl_date")} className="min-h-[44px] px-2 sm:px-3 text-xs">
              <Calendar className="w-3 h-3 mr-1" />
              <span className="hidden sm:inline">日期</span>
              <span className="sm:hidden">日</span>
              {sortField === (activeTab === "ath" || activeTab === "52w_ath" ? "ath_date" : "atl_date") && (sortOrder === "desc" ? "↓" : "↑")}
            </Button>
          </div>

          {/* 資料更新時間 */}
          {(activeTab === "ath" || activeTab === "atl" ? data?.lastUpdated : data?.lastUpdated52w) && (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {isMarketHours && isTodayTradeDay && (
                <Badge variant="outline" className="bg-amber-500/20 text-amber-500 border-amber-500/40 text-xs">
                  <Clock className="w-3 h-3 mr-1" />
                  盤中即時
                </Badge>
              )}
              <p className="text-xs text-muted-foreground">
                資料更新時間：{new Date(activeTab === "ath" || activeTab === "atl" ? data!.lastUpdated : data!.lastUpdated52w).toLocaleString("zh-TW")}
              </p>
            </div>
          )}
        </Card>

        {/* 載入中 */}
        {mutation.isPending && (
          <Card className="p-8 text-center">
            <RefreshCw className="w-8 h-8 mx-auto animate-spin mb-2" />
            <p className="text-muted-foreground">載入中...</p>
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

        {/* 清單 */}
        {!mutation.isPending && !mutation.isError && (
          <>
            {filteredAndSorted.length === 0 ? (
              <Card className="p-8 text-center">
                <p className="text-muted-foreground">
                  {search ? "沒有符合搜尋條件的股票" : "目前無符合條件的股票"}
                </p>
              </Card>
            ) : (
              <div className="space-y-4 sm:space-y-6">
                {groupedRecords.map(({ category, label, records }) => (
                  <div key={category} className="space-y-2">
                    {/* Category Header */}
                    <div className="flex flex-wrap items-center gap-2 sticky top-0 bg-background/95 backdrop-blur-sm py-2 z-10 border-b border-border">
                      <h3 className={`text-sm font-semibold ${getSectorCategoryDisplay(category).color}`}>
                        {label}
                      </h3>
                      <Badge variant="outline" className="text-xs">{records.length} 檔</Badge>
                      <span className="text-xs text-muted-foreground hidden sm:inline">
                        主要指標：{records[0]?.primaryValuationMetric}
                      </span>
                    </div>

                    {/* 桌面版：表格 */}
                    <div className="hidden sm:block overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                      <Table className="min-w-[800px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="py-2">代碼</TableHead>
                            <TableHead className="py-2">公司名稱</TableHead>
                            <TableHead className="max-w-[160px] py-2">產業</TableHead>
                            <TableHead className="text-right py-2">價格</TableHead>
                            <TableHead className="text-right py-2">
                              {activeTab === "ath" || activeTab === "52w_ath" 
                                ? (activeTab === "ath" ? "近5日歷史新高" : "52週新高")
                                : (activeTab === "atl" ? "近5日歷史新低" : "52週新低")}
                            </TableHead>
                            <TableHead className="text-right py-2">創建日期</TableHead>
                            <TableHead className="text-right py-2">距財報</TableHead>
                            <TableHead className="text-right py-2">
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                                    Forward P/E
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="text-xs max-w-[250px]">
                                      股價 ÷ 未來12個月預估每股盈餘。數字愈低代表用愈少的價格買到相同的預期盈餘，但需搭配同業比較，不同產業合理區間差異很大。
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </TableHead>
                            <TableHead className="text-right py-2">
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                                    PEG
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="text-xs max-w-[250px]">
                                      股價 ÷ 預估成長率。1.0-2.0較為合理，&gt;2.5相對昂貴，&lt;1.0相對便宜。週期性/資產密集型股票的PEG參考性較低，早期虧損股不適用。
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </TableHead>
                            <TableHead className="text-right py-2">
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                                    P/S
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="text-xs max-w-[250px]">
                                      股價 ÷ 每股營收(過去12個月)。常用於還未盈利或成長期公司，數字愈低代表相對營收付出的價格愈低，早期虧損股與高成長軟體股主要參考這項指標。
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </TableHead>
                            <TableHead className="text-right py-2">
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger className="cursor-help underline decoration-dotted decoration-muted-foreground">
                                    P/B
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="text-xs max-w-[250px]">
                                      股價 ÷ 每股淨資產(帳面價值)。金融股、資產密集型(地產/REITs)常用這項指標，數字愈低代表股價相對帳面資產愈便宜，需注意帳面價值本身可能被高估或低估。
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {records.map((record) => (
                            <TableRow
                              key={record.symbol}
                              className={activeTab === "ath" ? "bg-green-500/5" : "bg-red-500/5"}
                            >
                              <TableCell className="font-mono font-medium py-2">
                                <div className="flex items-center gap-2">
                                  {record.symbol}
                                </div>
                              </TableCell>
                              <TableCell className="max-w-[200px] truncate py-2">
                                {record.company_name}
                              </TableCell>
                              <TableCell className="max-w-[160px] text-xs py-2">
                                {record.industry ? (
                                  <div className="leading-tight">
                                    <div className="truncate">{record.industry}</div>
                                    {record.sector && <div className="text-muted-foreground truncate">{record.sector}</div>}
                                  </div>
                                ) : record.sector ? (
                                  <span className="text-muted-foreground">{record.sector}</span>
                                ) : (
                                  <span className="text-muted-foreground">N/A</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right font-mono py-2">
                                {formatPrice(record.last_close)}
                              </TableCell>
                              <TableCell className="text-right font-mono py-2">
                                {(activeTab === "ath" || activeTab === "52w_ath")
                                  ? formatPrice(record.ath_price || 0)
                                  : formatPrice(record.atl_price || 0)}
                              </TableCell>
                              <TableCell className="text-right py-2">
                                {(activeTab === "ath" || activeTab === "52w_ath")
                                  ? formatDate(record.ath_date)
                                  : formatDate(record.atl_date)}
                              </TableCell>
                              <TableCell className="text-right py-2">
                                {record.days_to_earnings !== null ? (
                                  <span
                                    className={
                                      record.days_to_earnings <= 3
                                        ? "text-orange-500 font-medium"
                                        : ""
                                    }
                                    title={record.next_earnings_date ? `財報日期: ${record.next_earnings_date}` : ""}
                                  >
                                    {record.days_to_earnings}天
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground text-xs">無資料</span>
                                )}
                              </TableCell>
                              {/* Forward P/E */}
                              <TableCell className="text-right py-2">
                                {record.forwardPE !== null ? (
                                  <div>
                                    <span className="font-mono">{formatValuation(record.forwardPE)}</span>
                                    {record.peerAvgForwardPE !== null && (
                                      <div className="text-xs text-muted-foreground" title={`基於${record.peerCount}家同業公司的Forward P/E中位數`}>
                                        同業: {record.peerAvgForwardPE.toFixed(2)}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground text-xs">N/A</span>
                                )}
                              </TableCell>
                              {/* PEG with simplified display */}
                              <TableCell className="text-right py-2">
                                {shouldShowPEG(record.sectorCategory) && record.pegNearTerm !== null ? (
                                  <span className="font-mono">{formatValuation(record.pegNearTerm)}</span>
                                ) : (
                                  <span className="text-muted-foreground text-xs">
                                    {getPEGDisplayNote(record.sectorCategory) ?? "N/A"}
                                  </span>
                                )}
                              </TableCell>
                              {/* P/S */}
                              <TableCell className="text-right py-2">
                                {record.priceToSales !== null ? (
                                  <span className="font-mono">{formatValuation(record.priceToSales)}</span>
                                ) : (
                                  <span className="text-muted-foreground text-xs">N/A</span>
                                )}
                              </TableCell>
                              {/* P/B with percentile badge */}
                              <TableCell className="text-right py-2">
                                {record.priceToBook !== null ? (
                                  <div className="flex justify-end items-center">
                                    <span className="font-mono mr-2">{formatValuation(record.priceToBook)}</span>
                                    {record.peBookHistoricalPercentile !== null && (
                                      (() => {
                                        const badge = getPercentileBadge(record.peBookHistoricalPercentile);
                                        return badge ? (
                                          <span 
                                            title={formatPercentile(record.peBookHistoricalPercentile, "P/B")} 
                                            className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs border cursor-help ${badge.className}`}
                                          >
                                            {badge.text}
                                          </span>
                                        ) : null;
                                      })()
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground text-xs">N/A</span>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    {/* 手機版：卡片列表 */}
                    <div className="sm:hidden space-y-2">
                      {records.map((record) => {
                        return (
                          <Card key={record.symbol} className={`p-3 ${activeTab === "ath" ? "bg-green-500/5" : "bg-red-500/5"}`}>
                            {/* 卡片主要内容 - 始終顯示 */}
                            <div className="flex justify-between items-start mb-2">
                              <div className="min-w-0 flex-1">
                                <div className="font-mono font-semibold text-base">{record.symbol}</div>
                                <div className="text-sm text-muted-foreground truncate">{record.company_name}</div>
                              </div>
                              <Badge variant="outline" className={`ml-2 shrink-0 text-xs ${getExchangeBadge(record.exchange)}`}>
                                {record.exchange}
                              </Badge>
                            </div>

                            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm mb-2">
                              <div>
                                <div className="text-muted-foreground text-xs">價格</div>
                                <div className="font-mono">{formatPrice(record.last_close)}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground text-xs">
                                  {activeTab === "ath" || activeTab === "52w_ath" ? "歷史新高" : "歷史新低"}
                                </div>
                                <div className="font-mono">
                                  {(activeTab === "ath" || activeTab === "52w_ath")
                                    ? formatPrice(record.ath_price || 0)
                                    : formatPrice(record.atl_price || 0)}
                                </div>
                              </div>
                              <MetricWithInfo
                                label="Forward P/E"
                                value={record.forwardPE !== null ? formatValuation(record.forwardPE) : "N/A"}
                                explanation="股價 ÷ 未來12個月預估每股盈餘。數字愈低代表用愈少的價格買到相同的預期盈餘，但需搭配同業比較，不同產業合理區間差異很大。"
                                metricKey={`${record.symbol}-fwdpe`}
                              />
                              {shouldShowPEG(record.sectorCategory) ? (
                                <MetricWithInfo
                                  label="PEG"
                                  value={record.pegNearTerm !== null ? formatValuation(record.pegNearTerm) : "N/A"}
                                  explanation="股價 ÷ 預估成長率。1.0-2.0較為合理，>2.5相對昂貴，<1.0相對便宜。"
                                  metricKey={`${record.symbol}-peg`}
                                />
                              ) : (
                                <MetricWithInfo
                                  label="PEG"
                                  value={<span className="text-muted-foreground">{getPEGDisplayNote(record.sectorCategory) ?? "N/A"}</span>}
                                  explanation={getPEGDisplayNote(record.sectorCategory) ?? "此類型不適用"}
                                  metricKey={`${record.symbol}-peg`}
                                />
                              )}
                              <MetricWithInfo
                                label="P/S"
                                value={record.priceToSales !== null ? formatValuation(record.priceToSales) : "N/A"}
                                explanation="股價 ÷ 每股營收(過去12個月)。常用於還未盈利或成長期公司，數字愈低代表相對營收付出的價格愈低。"
                                metricKey={`${record.symbol}-ps`}
                              />
                              <MetricWithInfo
                                label="P/B"
                                value={record.priceToBook !== null ? formatValuation(record.priceToBook) : "N/A"}
                                explanation="股價 ÷ 每股淨資產(帳面價值)。金融股、資產密集型(地產/REITs)常用這項指標。"
                                metricKey={`${record.symbol}-pb`}
                              />
                            </div>

                            {/* 產業、創建日期、距財報、成交量 - 全部展開顯示 */}
                            <div className="mt-3 pt-3 border-t border-border space-y-2">
                              <div className="grid grid-cols-2 gap-2 text-sm">
                                <div>
                                  <div className="text-muted-foreground text-xs">產業</div>
                                  <div className="text-xs break-words">{record.industry || record.sector || "N/A"}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground text-xs">創建日期</div>
                                  <div className="text-xs">
                                    {(activeTab === "ath" || activeTab === "52w_ath")
                                      ? formatDate(record.ath_date)
                                      : formatDate(record.atl_date)}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground text-xs">距財報</div>
                                  <div className="text-xs">
                                    {record.days_to_earnings !== null ? (
                                      <span className={record.days_to_earnings <= 3 ? "text-orange-500 font-medium" : ""}>
                                        {record.days_to_earnings}天
                                      </span>
                                    ) : "無資料"}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground text-xs">成交量</div>
                                  <div className="font-mono text-xs">{formatVolume(record.volume)}</div>
                                </div>
                              </div>
                              {record.peerAvgForwardPE !== null && (
                                <div className="text-xs text-muted-foreground">
                                  同業Forward P/E中位數: {record.peerAvgForwardPE.toFixed(2)} (基於{record.peerCount}家同業)
                                </div>
                              )}
                              {record.peBookHistoricalPercentile !== null && (
                                <div className="text-xs text-muted-foreground">
                                  P/B歷史分位: {formatPercentile(record.peBookHistoricalPercentile, "P/B")}
                                </div>
                              )}
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </Layout>
  );
}