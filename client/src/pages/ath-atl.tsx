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
  TrendingUp,
  TrendingDown,
  Search,
  RefreshCw,
  ArrowUpDown,
  Volume2,
  Calendar,
  Clock,
} from "lucide-react";

// Dynamic import for nyse-holidays (client-side)
async function getNYSEHolidays(year: number): Promise<Set<string>> {
  try {
    const module = await import("nyse-holidays");
    const holidays = module.nyseHolidays(year);
    return new Set(holidays.map((h: { date: string }) => h.date));
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
  industry: string;
  last_close: number;
  ath_price: number | null;
  ath_date: string | null;
  atl_price: number | null;
  atl_date: string | null;
  change_pct: number;
  volume: number;
  list_type: "ATH" | "ATL" | "52W_ATH" | "52W_ATL";
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

export default function ATHATLPage() {
  const [activeTab, setActiveTab] = useState<TabType>("ath");
  const [search, setSearch] = useState("");
  const [exchange, setExchange] = useState<string>("all");
  const getDefaultSortField = (tab: TabType): SortField => {
    if (tab === "ath" || tab === "52w_ath") return "ath_date";
    return "atl_date";
  };
  
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [sortField, setSortField] = useState<SortField>("ath_date");
  
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
      const res = await apiRequest("GET", `/api/ath-atl?${params.toString()}`);
      return (await res.json()) as ATHATLResponse;
    },
  });

  // 自動在元件 mount 時獲取資料
  // 如果回傳空陣列，自動重試一次（可能是伺服器正在快取暖機）
  useEffect(() => {
    mutation.mutate();
  }, []);

  // Auto-retry if data is empty (server might be warming cache)
  useEffect(() => {
    if (mutation.isSuccess && 
        mutation.data && 
        mutation.data.ath.length === 0 && 
        mutation.data.atl.length === 0 && 
        mutation.data.ath52w.length === 0 && 
        mutation.data.atl52w.length === 0 &&
        mutation.failureCount < 2) {
      const timer = setTimeout(() => {
        console.log("[ATH-ATL] Empty data received, retrying...");
        mutation.mutate();
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [mutation.isSuccess, mutation.data, mutation.failureCount]);

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
  }, [records, search, sortOrder, activeTab]);

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

  const getExchangeBadge = (ex: string) => {
    const colors: Record<string, string> = {
      NYSE: "bg-blue-500/20 text-blue-500 border-blue-500/40",
      NASDAQ: "bg-purple-500/20 text-purple-500 border-purple-500/40",
      AMEX: "bg-green-500/20 text-green-500 border-green-500/40",
    };
    return colors[ex] || "";
  };

  return (
    <Layout title="ATH / ATL Scanner" subtitle="歷史新高/新低 | All-Time High & Low">
      <main className="mx-auto max-w-6xl px-4 py-6 space-y-4">
        {/* 控制區 */}
        <Card className="p-4">
          <div className="flex flex-col sm:flex-row flex-wrap gap-3 items-start sm:items-center justify-between">
            {/* Tab 切換 */}
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
              <Button
                variant={activeTab === "ath" ? "default" : "outline"}
                onClick={() => setActiveTab("ath")}
                className={activeTab === "ath" ? "bg-green-600 hover:bg-green-700" : ""}
              >
                <TrendingUp className="w-4 h-4 mr-1" />
                ATH (歷史新高)
              </Button>
              <Button
                variant={activeTab === "atl" ? "default" : "outline"}
                onClick={() => setActiveTab("atl")}
                className={activeTab === "atl" ? "bg-red-600 hover:bg-red-700" : ""}
              >
                <TrendingDown className="w-4 h-4 mr-1" />
                ATL (歷史新低)
              </Button>
              <Button
                variant={activeTab === "52w_ath" ? "default" : "outline"}
                onClick={() => setActiveTab("52w_ath")}
                className={activeTab === "52w_ath" ? "bg-green-600 hover:bg-green-700" : ""}
              >
                <TrendingUp className="w-4 h-4 mr-1" />
                52週新高
              </Button>
              <Button
                variant={activeTab === "52w_atl" ? "default" : "outline"}
                onClick={() => setActiveTab("52w_atl")}
                className={activeTab === "52w_atl" ? "bg-red-600 hover:bg-red-700" : ""}
              >
                <TrendingDown className="w-4 h-4 mr-1" />
                52週新低
              </Button>
            </div>

            {/* 交易所篩選 */}
            <select
              value={exchange}
              onChange={(e) => setExchange(e.target.value)}
              className="px-3 py-2 rounded-md border border-border bg-background text-sm"
            >
              <option value="all">全部交易所</option>
              <option value="NYSE">NYSE</option>
              <option value="NASDAQ">NASDAQ</option>
              <option value="AMEX">AMEX</option>
            </select>
          </div>

          {/* 搜尋與排序 */}
          <div className="flex flex-wrap gap-3 mt-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="搜尋代碼或公司名稱..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              <RefreshCw className={`w-4 h-4 mr-1 ${mutation.isPending ? "animate-spin" : ""}`} />
              重新整理
            </Button>
          </div>

          {/* 排序按鈕 */}
          <div className="flex flex-wrap gap-2 mt-3">
            <Button variant="ghost" size="sm" onClick={() => handleSort("change_pct")}>
              <ArrowUpDown className="w-3 h-3 mr-1" />
              漲跌幅 {sortField === "change_pct" && (sortOrder === "desc" ? "↓" : "↑")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleSort("volume")}>
              <Volume2 className="w-3 h-3 mr-1" />
              成交量 {sortField === "volume" && (sortOrder === "desc" ? "↓" : "↑")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleSort(activeTab === "ath" || activeTab === "52w_ath" ? "ath_date" : "atl_date")}>
              <Calendar className="w-3 h-3 mr-1" />
              日期 {sortField === (activeTab === "ath" || activeTab === "52w_ath" ? "ath_date" : "atl_date") && (sortOrder === "desc" ? "↓" : "↑")}
            </Button>
          </div>

          {/* 資料更新時間 */}
          {data?.lastUpdated && (
            <div className="flex items-center gap-2 mt-3">
              {isMarketHours && isTodayTradeDay && (
                <Badge variant="outline" className="bg-amber-500/20 text-amber-500 border-amber-500/40">
                  <Clock className="w-3 h-3 mr-1" />
                  盤中即時
                </Badge>
              )}
              <p className="text-xs text-muted-foreground">
                資料更新時間：{new Date(data.lastUpdated).toLocaleString("zh-TW")}
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
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>代碼</TableHead>
                      <TableHead>公司名稱</TableHead>
                      <TableHead>交易所</TableHead>
                      <TableHead className="text-right">價格</TableHead>
                      <TableHead className="text-right">
                        {activeTab === "ath" || activeTab === "52w_ath" 
                          ? (activeTab === "ath" ? "近5日歷史新高" : "52週新高")
                          : (activeTab === "atl" ? "近5日歷史新低" : "52週新低")}
                      </TableHead>
                      <TableHead className="text-right">漲跌幅</TableHead>
                      <TableHead className="text-right">成交量</TableHead>
                      <TableHead className="text-right">創建日期</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAndSorted.map((record) => (
                      <TableRow
                        key={record.symbol}
                        className={activeTab === "ath" ? "bg-green-500/5" : "bg-red-500/5"}
                      >
                        <TableCell className="font-mono font-medium">
                          {record.symbol}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate">
                          {record.company_name}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={getExchangeBadge(record.exchange)}>
                            {record.exchange}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatPrice(record.last_close)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {(activeTab === "ath" || activeTab === "52w_ath")
                            ? formatPrice(record.ath_price || 0)
                            : formatPrice(record.atl_price || 0)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={
                              record.change_pct >= 0
                                ? "text-green-500"
                                : "text-red-500"
                            }
                          >
                            {record.change_pct >= 0 ? "+" : ""}
                            {record.change_pct.toFixed(2)}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatVolume(record.volume)}
                        </TableCell>
                        <TableCell className="text-right">
                          {(activeTab === "ath" || activeTab === "52w_ath")
                            ? formatDate(record.ath_date)
                            : formatDate(record.atl_date)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </main>
    </Layout>
  );
}