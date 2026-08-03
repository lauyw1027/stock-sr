/**
 * 日元 Carry Trade 平倉風險監控 - Express API 路由
 */

import type { Server } from 'http';
import type { Express, Request, Response, NextFunction } from 'express';
import YahooFinance from 'yahoo-finance2';
import axios from 'axios';
import {
  type CarryTradeRiskData,
  type CftcPosition,
  type QuoteData,
  CARRY_TRADE_CACHE,
} from '../utils/carryTradeTypes.js';

// yahoo-finance2 v3+ requires instantiation with new
const yahooFinance = new YahooFinance();

// ============================================================================
// 常數配置
// ============================================================================

const LOOKBACK_DAYS = 90;
const CFTC_WEEKS = 12;

// ============================================================================
// 記憶體快取
// ============================================================================

interface CacheEntry {
  data: CarryTradeRiskData;
  timestamp: number;
}

let cache: CacheEntry | null = null;

// ============================================================================
// Yahoo Finance 資料抓取
// ============================================================================

async function fetchYahooData(): Promise<{
  USDJPY: QuoteData[];
  VIX: QuoteData[];
}> {
  const tickers = {
    USDJPY: 'JPY=X',
    VIX: '^VIX',
    NIKKEI: '^N225',
    SP500: '^GSPC',
    BTC: 'BTC-USD',
    UST10Y: '^TNX',
  };

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);

  const result: {
    USDJPY: QuoteData[];
    VIX: QuoteData[];
  } = {
    USDJPY: [],
    VIX: [],
  };

  for (const [key, symbol] of Object.entries(tickers)) {
    try {
      const chart = await yahooFinance.chart(symbol, {
        period1: start,
        period2: end,
        interval: '1d',
      });

      const quotes = (chart.quotes ?? []).filter((q) => q.close !== null);
      const mapped = quotes.map((q) => ({
        date: q.date instanceof Date ? q.date.toISOString().slice(0, 10) : new Date(q.date).toISOString().slice(0, 10),
        close: q.close,
      }));

      if (key === 'USDJPY') {
        result.USDJPY = mapped;
      } else if (key === 'VIX') {
        result.VIX = mapped;
      }
    } catch (e) {
      console.warn(`[CarryTrade] Yahoo Finance fetch ${symbol} failed:`, (e as Error).message);
    }
  }

  return result;
}

// ============================================================================
// FRED 資料抓取
// ============================================================================

async function fetchFredSeries(seriesId: string, lookbackDays: number = LOOKBACK_DAYS): Promise<{ date: string; value: number }[] | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return null;
  }

  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().slice(0, 10);

  const url = 'https://api.stlouisfed.org/fred/series/observations';

  try {
    const resp = await axios.get(url, {
      params: {
        series_id: seriesId,
        api_key: apiKey,
        file_type: 'json',
        observation_start: startStr,
      },
      timeout: 20000,
    });

    const obs = resp.data.observations ?? [];
    if (obs.length === 0) return null;

    return obs
      .map((o: { date: string; value: string }) => ({
        date: o.date,
        value: parseFloat(o.value),
      }))
      .filter((o: { value: number }) => !isNaN(o.value));
  } catch (e) {
    console.warn(`[CarryTrade] FRED series ${seriesId} fetch failed:`, (e as Error).message);
    return null;
  }
}

async function fetchFredData() {
  const result: Record<string, unknown> = {};

  const ust10 = await fetchFredSeries('DGS10', LOOKBACK_DAYS);
  if (ust10) result.FRED_UST10Y = ust10;

  const hySpread = await fetchFredSeries('BAMLH0A0HYM2', LOOKBACK_DAYS);
  if (hySpread) result.HY_SPREAD = hySpread;

  return result;
}

// ============================================================================
// CFTC COT 資料抓取
// ============================================================================

async function fetchCftcJpyPositioning(weeks: number = CFTC_WEEKS): Promise<CftcPosition[] | null> {
  const url = 'https://publicreporting.cftc.gov/resource/jun7-fc8e.json';

  try {
    const resp = await axios.get(url, {
      params: {
        '$where': "market_and_exchange_names = 'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE'",
        '$order': 'report_date_as_yyyy_mm_dd DESC',
        '$limit': weeks,
      },
      timeout: 20000,
    });

    const data = resp.data;
    if (!data || data.length === 0) return null;

    const parsed = data
      .map((row: Record<string, string>) => ({
        date: row.report_date_as_yyyy_mm_dd,
        long: parseFloat(row.noncomm_positions_long_all) || 0,
        short: parseFloat(row.noncomm_positions_short_all) || 0,
      }))
      .map((row: { date: string; long: number; short: number }) => ({
        ...row,
        net: row.long - row.short,
      }))
      .sort((a: CftcPosition, b: CftcPosition) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return parsed;
  } catch (e) {
    console.warn('[CarryTrade] CFTC data fetch failed:', (e as Error).message);
    return null;
  }
}

// ============================================================================
// 風險評分計算
// ============================================================================

function computeRiskScore(yahooData: { USDJPY: QuoteData[]; VIX: QuoteData[] }, cftcData: CftcPosition[] | null) {
  const scores: {
    usdjpySpeed: number;
    vixLevel: number;
    cftcPositioning: number;
    total: number;
    level: '低' | '中' | '高';
  } = {
    usdjpySpeed: 0,
    vixLevel: 0,
    cftcPositioning: 0,
    total: 0,
    level: '低',
  };

  // 1. USD/JPY 速度分數 (0-40)
  const usdjpySeries = yahooData.USDJPY;
  if (usdjpySeries.length >= 3) {
    const latest = usdjpySeries[usdjpySeries.length - 1].close;
    const twoDaysAgo = usdjpySeries[usdjpySeries.length - 3].close;
    if (latest !== null && twoDaysAgo !== null && twoDaysAgo !== 0) {
      const ret2d = (latest - twoDaysAgo) / twoDaysAgo;
      // 日元升值（USD/JPY 下降）對 carry trade 是風險訊號
      // 負回報表示日元升值，分數應該高
      scores.usdjpySpeed = Math.min(Math.max(-ret2d * 1000, 0), 40);
    }
  }
  scores.usdjpySpeed = Math.round(scores.usdjpySpeed * 10) / 10;

  // 2. VIX 水平分數 (0-30)
  const vixSeries = yahooData.VIX;
  if (vixSeries.length > 0) {
    const latestVix = vixSeries[vixSeries.length - 1].close;
    if (latestVix !== null) {
      // VIX 低於 12 為 0 分，35 為 30 分
      scores.vixLevel = Math.min(Math.max((latestVix - 12) / (35 - 12) * 30, 0), 30);
    }
  }
  scores.vixLevel = Math.round(scores.vixLevel * 10) / 10;

  // 3. CFTC 倉位擁擠度分數 (0-30)
  if (cftcData && cftcData.length > 1) {
    const nets = cftcData.map((d) => d.net);
    const latestNet = nets[nets.length - 1];
    const histMin = Math.min(...nets);
    const histMax = Math.max(...nets);

    if (histMax !== histMin) {
      // 淨空頭（負值）越接近歷史低點，市場越擁擠、風險越大
      // 最新淨倉位 = histMin（最大淨空頭）→ 30分（完全擁擠）
      // 最新淨倉位 = histMax（最大淨多頭）→ 0分（無擁擠）
      scores.cftcPositioning = Math.min(Math.max((histMax - latestNet) / (histMax - histMin) * 30, 0), 30);
    }
  }
  scores.cftcPositioning = Math.round(scores.cftcPositioning * 10) / 10;

  // 4. 總分與等級
  scores.total = Math.round((scores.usdjpySpeed + scores.vixLevel + scores.cftcPositioning) * 10) / 10;
  scores.level = scores.total < 30 ? '低' : scores.total < 60 ? '中' : '高';

  return scores;
}

// ============================================================================
// 主資料處理函式
// ============================================================================

async function fetchCarryTradeData(): Promise<CarryTradeRiskData> {
  // 並行抓取三個資料源
  const [yahooData, fredData, cftcData] = await Promise.all([
    fetchYahooData(),
    fetchFredData(),
    fetchCftcJpyPositioning(),
  ]);

  // 計算風險評分
  const score = computeRiskScore(yahooData, cftcData);

  // 組裝回應
  let usdjpyPrice: number | null = null;
  let usdjpyChange2dPct: number | null = null;

  if (yahooData.USDJPY.length >= 3) {
    const latest = yahooData.USDJPY[yahooData.USDJPY.length - 1];
    const twoDaysAgo = yahooData.USDJPY[yahooData.USDJPY.length - 3];

    if (latest.close !== null) {
      usdjpyPrice = latest.close;
      if (twoDaysAgo.close !== null && twoDaysAgo.close !== 0) {
        usdjpyChange2dPct = ((latest.close - twoDaysAgo.close) / twoDaysAgo.close) * 100;
      }
    }
  }

  let vixValue: number | null = null;
  if (yahooData.VIX.length > 0) {
    vixValue = yahooData.VIX[yahooData.VIX.length - 1].close;
  }

  let cftcNetNoncomm: number | null = null;
  let cftcHistory: CftcPosition[] = [];

  if (cftcData && cftcData.length > 0) {
    cftcNetNoncomm = cftcData[cftcData.length - 1].net;
    cftcHistory = cftcData;
  }

  const result: CarryTradeRiskData = {
    usdjpy: usdjpyPrice !== null ? {
      price: usdjpyPrice,
      change2dPct: usdjpyChange2dPct !== null ? Math.round(usdjpyChange2dPct * 100) / 100 : null,
    } : null,
    vix: vixValue !== null ? Math.round(vixValue * 100) / 100 : null,
    cftc: cftcNetNoncomm !== null ? {
      netNoncomm: cftcNetNoncomm,
      history: cftcHistory,
    } : null,
    score,
    lastUpdated: new Date().toISOString(),
  };

  return result;
}

// ============================================================================
// 路由註冊
// ============================================================================

export function registerCarryTradeRoutes(
  _httpServer: Server,
  app: Express
): void {
  // CORS 中間件
  app.use((req: Request, res: Response, next: NextFunction) => {
    const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://stocksr.online';
    const origin = req.headers.origin as string | undefined;

    if (origin === allowedOrigin || !origin) {
      res.setHeader('Access-Control-Allow-Origin', origin || allowedOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  });

  // GET /api/carry-risk
  app.get('/api/carry-risk', async (_req: Request, res: Response) => {
    try {
      // 檢查快取
      const now = Date.now();
      if (cache && now - cache.timestamp < CARRY_TRADE_CACHE.TTL_MS) {
        return res.json(cache.data);
      }

      // 抓取新資料
      const data = await fetchCarryTradeData();

      // 更新快取
      cache = {
        data,
        timestamp: now,
      };

      res.json(data);
    } catch (e) {
      console.error('[CarryTrade API] Error fetching data:', e);
      res.status(500).json({
        error: 'Failed to fetch carry trade risk data',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  // POST /api/carry-risk/refresh - 手動強制刷新快取
  app.post('/api/carry-risk/refresh', async (req: Request, res: Response) => {
    try {
      const secret = req.headers.authorization?.replace('Bearer ', '');
      const expectedSecret = process.env.CARRY_TRADE_SECRET;

      if (expectedSecret && secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // 清除快取並重新抓取
      cache = null;
      const data = await fetchCarryTradeData();

      cache = {
        data,
        timestamp: Date.now(),
      };

      res.json({ success: true, data });
    } catch (e) {
      console.error('[CarryTrade API] Error refreshing data:', e);
      res.status(500).json({
        error: 'Failed to refresh carry trade risk data',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  console.log('[CarryTrade] Routes registered');
}