import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import YahooFinancePkg from "yahoo-finance2";
import {
  computeIndicators,
  buildZones,
  buildNarrative,
  type Candle,
  type AnalyzeResult,
} from "./analysis";
import { scanAthAtl, getCachedData } from "./stocks";

// yahoo-finance2 v3 需要實例化；suppressNotices 關閉調查/環境通知
const YahooFinance: any = (YahooFinancePkg as any).default ?? YahooFinancePkg;
const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

/** 常見交易所後綴，供模糊代號提示 */
const SUFFIX_HINTS = [
  { suffix: ".HK", market: "香港交易所" },
  { suffix: ".T", market: "東京證券交易所" },
  { suffix: ".SS", market: "上海證券交易所" },
  { suffix: ".SZ", market: "深圳證券交易所" },
  { suffix: ".TW", market: "台灣證券交易所" },
  { suffix: ".TWO", market: "台灣櫃買中心" },
  { suffix: ".L", market: "倫敦證券交易所" },
  { suffix: ".KS", market: "韓國交易所" },
];

/**
 * 判斷代號是否可能有市場模糊性：
 * 純數字代號（如 0700、600519）沒有後綴時，可能對應多個市場。
 */
function isAmbiguous(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  if (t.includes(".")) return false; // 已含後綴
  // 純數字代號幾乎必然需要指定市場
  if (/^\d{3,6}$/.test(t)) return true;
  return false;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.post("/api/analyze", async (req: Request, res: Response) => {
    try {
      const rawTicker: string = (req.body?.ticker ?? "").toString().trim();
      const suffix: string = (req.body?.suffix ?? "").toString().trim();
      const force: boolean = req.body?.force === true;

      if (!rawTicker) {
        return res.status(400).json({ error: "請輸入股票代號。" });
      }

      // 組合最終代號
      let ticker = rawTicker.toUpperCase();
      if (suffix && !ticker.includes(".")) {
        ticker = ticker + suffix;
      }

      // 模糊性檢查：純數字且無後綴且使用者未強制執行
      if (!suffix && isAmbiguous(ticker) && !force) {
        return res.status(200).json({
          ambiguous: true,
          ticker,
          message: `代號「${ticker}」可能對應多個市場，請選擇交易所後綴後再分析。`,
          hints: SUFFIX_HINTS,
        });
      }

      // 抓取近 1 年日線 OHLCV
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 400); // 多抓一點以確保 MA200 有足夠資料

      let chart: any;
      try {
        chart = await yahooFinance.chart(ticker, {
          period1: start,
          period2: end,
          interval: "1d",
        });
      } catch (e: any) {
        return res.status(200).json({
          error: "fetch_failed",
          ticker,
          message: `無法從 Yahoo Finance 取得「${ticker}」的資料。請確認代號與交易所後綴是否正確（例如港股需加 .HK，日股 .T，滬股 .SS，深股 .SZ，台股 .TW）。`,
          hints: SUFFIX_HINTS,
          detail: (e?.message || "").toString().slice(0, 200),
        });
      }

      const quotes = (chart?.quotes ?? []) as any[];
      const candles: Candle[] = quotes
        .filter(
          (q) =>
            q &&
            q.close != null &&
            q.open != null &&
            q.high != null &&
            q.low != null
        )
        .map((q) => ({
          date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume ?? 0,
        }));

      // 只保留最近約 1 年（252 交易日）用於顯示，但保留全部用於 MA200 計算
      const meta = chart?.meta ?? {};
      const currency = meta.currency ? currencySymbol(meta.currency) : "";
      const exchangeName = meta.fullExchangeName || meta.exchangeName || "未知";
      const companyName = meta.longName || meta.shortName || meta.symbol || ticker;

      // 資料充足性檢查
      if (candles.length < 20) {
        return res.status(200).json({
          error: "insufficient_data",
          ticker,
          message: `「${ticker}」可取得的交易資料不足（僅 ${candles.length} 筆），無法進行技術分析。可能為新上市、暫停交易或代號錯誤。`,
          bars: candles.length,
        });
      }

      const price = Math.round(candles[candles.length - 1].close * 100) / 100;
      const dataAsOf = candles[candles.length - 1].date;

      const ind = computeIndicators(candles);
      const { support, resistance, confluence } = buildZones(ind, price);
      const narrative = buildNarrative(ind, price, support, resistance, currency);

      // 可用 / 缺失資料
      const available: string[] = [];
      const missing: string[] = [];
      const mark = (label: string, ok: boolean) => (ok ? available : missing).push(label);
      mark("MA20", ind.ma20 !== null);
      mark("MA50", ind.ma50 !== null);
      mark("MA200", ind.ma200 !== null);
      mark("ATR14", ind.atr14 !== null);
      mark("樞紐點/R1/R2/S1/S2", ind.pivot !== null);
      mark("近1月高低", ind.high1m !== null);
      mark("近3月高低", ind.high3m !== null);
      mark("近1年高低", ind.high1y !== null);
      mark("Fibonacci 回撤", ind.fib382 !== null);
      mark("Camarilla 樞紐", ind.camH3 !== null);
      available.push(`OHLCV 日線 ${candles.length} 筆`);
      missing.push("逐筆成交量分佈（volume profile）— Yahoo 未提供價量分佈資料");
      missing.push("即時報價 — 使用最後收盤價作為參考價");

      const limitations = [
        "使用 Yahoo Finance 日線 OHLCV，非即時報價；目前價格為最後收盤價。",
        "未計算成交量分佈（無價量資料），共振改以均線、歷史高低、盤整平台與 Fibonacci 重疊判定。",
        candles.length < 200 ? "資料未滿 200 交易日，MA200 可能為 N/A 或代表性不足。" : "",
        "支撐/阻力以區間呈現，半寬 = max(ATR14×0.2, 價格×0.4%)。",
      ].filter(Boolean);

      const result: AnalyzeResult = {
        status: {
          companyName,
          ticker: meta.symbol || ticker,
          exchange: exchangeName,
          currentPrice: price,
          currency: meta.currency || "",
          dataAsOf,
          period: `${candles[0].date} ~ ${dataAsOf}（日線，共 ${candles.length} 筆）`,
          available,
          missing,
          limitations,
        },
        indicators: ind,
        resistanceZones: resistance,
        supportZones: support,
        confluenceZones: confluence,
        candles: candles.slice(Math.max(0, candles.length - 252)),
        ...narrative,
      };

      return res.status(200).json(result);
    } catch (e: any) {
      return res.status(400).json({
        error: "server_error",
        message: "分析過程發生錯誤，請稍後再試或確認代號。",
        detail: (e?.message || "").toString().slice(0, 300),
      });
    }
  });

  // ATH/ATL API
  app.get("/api/ath-atl", async (_req: Request, res: Response) => {
    try {
      const type = _req.query.type as string || "all"; // all, ath, atl
      const exchange = _req.query.exchange as string || "all"; // all, NYSE, NASDAQ, AMEX, HK, T, SS, SZ, TW, TWO, L, KS
      const refresh = _req.query.refresh === "true";
      
      let data = getCachedData();
      
      // 如果沒有快取或是要求強制刷新，則重新掃描
      if (!data || refresh) {
        console.log(`[API] Scanning ATH/ATL (refresh: ${refresh})`);
        data = await scanAthAtl();
      }
      
      let result = {
        ath: data.ath,
        atl: data.atl,
        lastUpdated: data.lastUpdated,
      };
      
      // 過濾交易所 (支援美股和國際市場)
      if (exchange !== "all") {
        result.ath = result.ath.filter(s => s.exchange === exchange);
        result.atl = result.atl.filter(s => s.exchange === exchange);
      }
      
      // 過濾類型
      if (type === "ath") {
        result.atl = [];
      } else if (type === "atl") {
        result.ath = [];
      }
      
      res.json(result);
    } catch (e: any) {
      console.error("[API] ATH/ATL error:", e);
      res.status(500).json({ error: "Failed to fetch ATH/ATL data", detail: e.message });
    }
  });

  return httpServer;
}

function currencySymbol(code: string): string {
  const map: Record<string, string> = {
    USD: "$",
    HKD: "HK$",
    CNY: "¥",
    JPY: "¥",
    TWD: "NT$",
    GBP: "£",
    KRW: "₩",
    EUR: "€",
  };
  return map[code] || "";
}
