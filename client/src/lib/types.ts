// 前端使用的分析結果型別（對應後端 server/analysis.ts）

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Zone {
  center: number;
  low: number;
  high: number;
  methods: string[];
  strength: "強" | "中" | "弱";
  timeframe: string;
  isConfluence: boolean;
  note: string;
}

export interface ConsolidationZone {
  low: number;
  high: number;
  startDate: string;
  endDate: string;
  bars: number;
}

export interface Indicators {
  ma20: number | null;
  ma50: number | null;
  ma200: number | null;
  atr14: number | null;
  pivot: number | null;
  r1: number | null;
  r2: number | null;
  s1: number | null;
  s2: number | null;
  high1m: number | null;
  low1m: number | null;
  high3m: number | null;
  low3m: number | null;
  high1y: number | null;
  low1y: number | null;
  fib382: number | null;
  fib500: number | null;
  fib618: number | null;
  fibHi: number | null;
  fibLo: number | null;
  camH3: number | null;
  camH4: number | null;
  camH5: number | null;
  camL3: number | null;
  camL4: number | null;
  camL5: number | null;
  consolidation: ConsolidationZone[];
  turningZones: number[];
  zoneHalfWidth: number | null;
}

export interface AnalyzeResult {
  status: {
    companyName: string;
    ticker: string;
    exchange: string;
    currentPrice: number | null;
    currency: string;
    dataAsOf: string | null;
    period: string;
    available: string[];
    missing: string[];
    limitations: string[];
  };
  indicators: Indicators;
  resistanceZones: Zone[];
  supportZones: Zone[];
  confluenceZones: Zone[];
  candles: Candle[];
  interpretation: {
    nearest: string;
    strongest: string;
    breakoutCondition: string;
    fakeoutSignal: string;
    limitation: string;
  };
  shortTerm: { bull: string; bear: string; neutral: string };
  midTerm: { bull: string; bear: string; neutral: string };
}

export interface AmbiguousResponse {
  ambiguous: true;
  ticker: string;
  message: string;
  hints: { suffix: string; market: string }[];
}

export interface ErrorResponse {
  error: string;
  ticker?: string;
  message: string;
  hints?: { suffix: string; market: string }[];
  bars?: number;
  detail?: string;
}

export type ApiResponse = AnalyzeResult | AmbiguousResponse | ErrorResponse;
