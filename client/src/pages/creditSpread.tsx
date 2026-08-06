import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Layout } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  RefreshCw,
  AlertTriangle,
  Info,
  ArrowDown,
  ArrowUp,
  DollarSign,
  Percent,
  Calendar,
} from "lucide-react";

// Types matching server response
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
  reversalSignal: {
    confirmed: boolean;
    strength: number;
  };
  ivRank: number | null;
  daysToEarnings: number | null;
}

interface CreditSpreadResponse {
  bearCallSpreads: RankedCandidate[];
  bullPutSpreads: RankedCandidate[];
  lastUpdated: string;
}

// Style options
const STYLE_OPTIONS = [
  { value: "conservative", label: "保守 (Delta 0.15-0.20)" },
  { value: "balanced", label: "平衡 (Delta 0.20-0.30)" },
  { value: "aggressive", label: "激進 (Delta 0.30-0.40)" },
];

function formatNumber(num: number, decimals = 2): string {
  return num.toFixed(decimals);
}

function formatPercent(num: number): string {
  return `${num >= 0 ? "+" : ""}${num.toFixed(1)}%`;
}

// Disclaimer component
function Disclaimer() {
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 mb-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-200">
          <p className="font-semibold mb-1">以上為技術篩選結果，非投資建議</p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>下單前請自行覆核 IV 環境與大盤氛圍</li>
            <li>Black-Scholes 計算出的 Delta 是理論估算值，可能與市場真實隱含 Delta 有落差</li>
            <li>選擇權 bid/ask 資料可能有 15-20 分鐘延遲，不適合即時下單決策依據</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// Render a spread row
function SpreadRow({ 
  candidate, 
  onClick 
}: { 
  candidate: RankedCandidate; 
  onClick?: () => void;
}) {
  const isBearCall = candidate.direction === "bear_call";
  
  // 視覺規則
  const isHighROC = candidate.roc > 40;
  const isLowBuffer = candidate.breakevenBufferPct < 5;
  
  return (
    <TableRow 
      className="cursor-pointer hover:bg-muted/50"
      onClick={onClick}
    >
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          <span className="text-primary font-bold">{candidate.symbol}</span>
          {isBearCall ? (
            <Badge variant="outline" className="bg-red-500/20 text-red-400 border-red-500/30">
              <ArrowDown className="h-3 w-3 mr-1" />
              Bear Call
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/30">
              <ArrowUp className="h-3 w-3 mr-1" />
              Bull Put
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">{candidate.companyName}</div>
      </TableCell>
      
      <TableCell className="text-right">
        ${formatNumber(candidate.currentPrice)}
      </TableCell>
      
      <TableCell className="text-right">
        ${formatNumber(candidate.shortStrike)}
      </TableCell>
      
      <TableCell className="text-right">
        ${formatNumber(candidate.longStrike)}
      </TableCell>
      
      <TableCell>
        {candidate.expiration}
      </TableCell>
      
      <TableCell className="text-right text-green-400">
        <div className="flex items-center justify-end gap-1">
          <DollarSign className="h-3 w-3" />
          {formatNumber(candidate.netCredit)}
        </div>
      </TableCell>
      
      <TableCell className="text-right text-red-400">
        <div className="flex items-center justify-end gap-1">
          <DollarSign className="h-3 w-3" />
          {formatNumber(candidate.maxLoss)}
        </div>
      </TableCell>
      
      <TableCell className="text-right">
        <span className={isHighROC ? "text-green-400 font-bold" : ""}>
          {formatNumber(candidate.roc)}%
        </span>
      </TableCell>
      
      <TableCell className="text-right">
        <span className={isLowBuffer ? "text-orange-400 font-bold" : ""}>
          {formatNumber(candidate.breakevenBufferPct)}%
        </span>
      </TableCell>
      
      <TableCell className="text-center">
        {candidate.daysToEarnings !== null ? (
          <Badge variant={candidate.daysToEarnings <= 7 ? "destructive" : "outline"}>
            <Calendar className="h-3 w-3 mr-1" />
            {candidate.daysToEarnings} 天
          </Badge>
        ) : (
          <span className="text-muted-foreground">N/A</span>
        )}
      </TableCell>
      
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Percent className="h-3 w-3" />
          <span className={`font-bold ${
            candidate.score >= 70 ? "text-green-400" : 
            candidate.score >= 50 ? "text-yellow-400" : 
            "text-muted-foreground"
          }`}>
            {candidate.score}
          </span>
        </div>
      </TableCell>
    </TableRow>
  );
}

// Bear Call Table
function BearCallTable({ spreads, isLoading, onRefresh, style, setStyle }: {
  spreads: RankedCandidate[];
  isLoading: boolean;
  onRefresh: () => void;
  style: string;
  setStyle: (s: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">Bear Call 推薦</h3>
          <Badge variant="outline" className="bg-red-500/20 text-red-400 border-red-500/30">
            <ArrowDown className="h-3 w-3 mr-1" />
            歷史新高 (ATH) 股票
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className="bg-background border border-input rounded-md px-3 py-1.5 text-sm"
          >
            {STYLE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      
      {spreads.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          <Info className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>目前沒有符合條件的 Bear Call 候選股票</p>
        </Card>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>股票</TableHead>
                <TableHead className="text-right">股價</TableHead>
                <TableHead className="text-right">短腿履約價</TableHead>
                <TableHead className="text-right">長腿履約價</TableHead>
                <TableHead>到期日</TableHead>
                <TableHead className="text-right">淨收取權利金</TableHead>
                <TableHead className="text-right">最大虧損</TableHead>
                <TableHead className="text-right">ROC%</TableHead>
                <TableHead className="text-right">損益平衡緩衝%</TableHead>
                <TableHead className="text-center">距財報天數</TableHead>
                <TableHead className="text-right">綜合評分</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {spreads.map((spread) => (
                <SpreadRow key={`${spread.symbol}-${spread.direction}`} candidate={spread} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// Bull Put Table
function BullPutTable({ spreads, isLoading, onRefresh, style, setStyle }: {
  spreads: RankedCandidate[];
  isLoading: boolean;
  onRefresh: () => void;
  style: string;
  setStyle: (s: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">Bull Put 推薦</h3>
          <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/30">
            <ArrowUp className="h-3 w-3 mr-1" />
            歷史新低 (ATL) 股票
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className="bg-background border border-input rounded-md px-3 py-1.5 text-sm"
          >
            {STYLE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      
      {/* 提示文字 */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 flex items-start gap-2">
        <Info className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
        <p className="text-sm text-blue-200">
          候選已通過技術面反轉確認，但仍需自行評估是否為真正止跌訊號
        </p>
      </div>
      
      {spreads.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          <Info className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>目前沒有符合條件的 Bull Put 候選股票</p>
        </Card>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>股票</TableHead>
                <TableHead className="text-right">股價</TableHead>
                <TableHead className="text-right">短腿履約價</TableHead>
                <TableHead className="text-right">長腿履約價</TableHead>
                <TableHead>到期日</TableHead>
                <TableHead className="text-right">淨收取權利金</TableHead>
                <TableHead className="text-right">最大虧損</TableHead>
                <TableHead className="text-right">ROC%</TableHead>
                <TableHead className="text-right">損益平衡緩衝%</TableHead>
                <TableHead className="text-center">距財報天數</TableHead>
                <TableHead className="text-right">綜合評分</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {spreads.map((spread) => (
                <SpreadRow key={`${spread.symbol}-${spread.direction}`} candidate={spread} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function CreditSpread() {
  const [style, setStyle] = useState("balanced");
  
  const mutation = useMutation({
    mutationFn: async (styleValue: string) => {
      const res = await apiRequest("GET", `/api/credit-spread-recommendations?style=${styleValue}`);
      return (await res.json()) as CreditSpreadResponse;
    },
  });

  const handleRefresh = () => {
    mutation.mutate(style);
  };

  // Auto-load on mount
  useEffect(() => {
    if (!mutation.data && !mutation.isPending) {
      mutation.mutate(style);
    }
  }, []);

  const bearCallSpreads = mutation.data?.bearCallSpreads ?? [];
  const bullPutSpreads = mutation.data?.bullPutSpreads ?? [];
  const lastUpdated = mutation.data?.lastUpdated ?? "";

  return (
    <Layout>
      <div className="container mx-auto py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">信用價差推薦</h1>
            <p className="text-muted-foreground">
              歷史新高 → Bear Call Spread / 歷史新低 → Bull Put Spread
            </p>
          </div>
          {lastUpdated && (
            <div className="text-sm text-muted-foreground">
              最後更新: {new Date(lastUpdated).toLocaleString()}
            </div>
          )}
        </div>

        <Disclaimer />

        <Tabs defaultValue="bear-call" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="bear-call" className="gap-2">
              <TrendingDown className="h-4 w-4" />
              Bear Call ({bearCallSpreads.length})
            </TabsTrigger>
            <TabsTrigger value="bull-put" className="gap-2">
              <TrendingUp className="h-4 w-4" />
              Bull Put ({bullPutSpreads.length})
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="bear-call" className="mt-4">
            <BearCallTable 
              spreads={bearCallSpreads}
              isLoading={mutation.isPending}
              onRefresh={handleRefresh}
              style={style}
              setStyle={setStyle}
            />
          </TabsContent>
          
          <TabsContent value="bull-put" className="mt-4">
            <BullPutTable 
              spreads={bullPutSpreads}
              isLoading={mutation.isPending}
              onRefresh={handleRefresh}
              style={style}
              setStyle={setStyle}
            />
          </TabsContent>
        </Tabs>

        {mutation.isError && (
          <Card className="p-4 bg-red-500/10 border-red-500/30">
            <div className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="h-5 w-5" />
              <span>載入失敗: {(mutation.error as Error)?.message}</span>
            </div>
          </Card>
        )}
      </div>
    </Layout>
  );
}