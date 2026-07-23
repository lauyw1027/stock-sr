/**
 * divergence-scan.ts — 日線/週線全市場背離掃描模組（配合 divergence.ts v3）
 * 支援 is_live 標記：全市場掃描結果中會包含「即時/未確認」訊號（如FTNT剛創新高案例）
 */

import fs from "node:fs";
import path from "node:path";
import {
  analyzeDivergence, fetchCandles,
  type Timeframe, type ScanResult, type DivergenceResult,
  type InsufficientDataError, type Strength,
} from "./divergence";
import { getUSStocks, type StockInfo } from "./stocks";

const __filename = __filename || "";
const __dirname = path.dirname(__filename);

// Vercel 的 /var/task 是唯讀，只有 /tmp 可寫入
// 本地開發則使用專案根目錄下的 data/ 資料夾
const CACHE_DIR = process.env.VERCEL ? '/tmp' : path.resolve(process.cwd(), 'data');
const CACHE_FILE_1D = path.join(CACHE_DIR, "divergence-1d.json");
const CACHE_FILE_1WK = path.join(CACHE_DIR, "divergence-1wk.json");

interface CacheData {
  results: ScanResult[];
  lastUpdated: string;
  timeframe: Timeframe;
}

function toScanResult(divResult: DivergenceResult): ScanResult {
  return {
    symbol: divResult.symbol,
    company_name: divResult.company_name,
    exchange: divResult.exchange,
    timeframe: divResult.timeframe,
    divergence_type: divResult.divergence_type,
    strength: divResult.strength,
    matched_indicators: divResult.matched_indicators,
    matched_count: divResult.matched_count,
    is_live: divResult.is_live,
    last_close: divResult.last_close,
    swing_price_1: divResult.swing_price_1,
    swing_price_2: divResult.swing_price_2,
    swing_date_1: divResult.swing_date_1,
    swing_date_2: divResult.swing_date_2,
    updated_at: divResult.updated_at,
  };
}

function isInsufficientOrNoDivergence(
  result: DivergenceResult | InsufficientDataError
): result is InsufficientDataError {
  return "status" in result;
}

function saveCache(timeframe: Timeframe, results: ScanResult[]): void {
  const cacheFile = timeframe === "1d" ? CACHE_FILE_1D : CACHE_FILE_1WK;
  const data: CacheData = { results, lastUpdated: new Date().toISOString(), timeframe };
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
    console.log(`[Divergence-Scan] Saved cache to ${cacheFile}`);
  } catch (e) {
    console.error(`[Divergence-Scan] Failed to save cache:`, e);
  }
}

export function getCachedDivergence(timeframe: Timeframe): CacheData | null {
  const cacheFile = timeframe === "1d" ? CACHE_FILE_1D : CACHE_FILE_1WK;
  try {
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as CacheData;
    }
  } catch (e) {
    console.error(`[Divergence-Scan] Failed to read cache:`, e);
  }
  return null;
}

async function scanStockForDivergence(
  stock: StockInfo,
  timeframe: Timeframe
): Promise<ScanResult | null> {
  try {
    const candles = await fetchCandles(stock.symbol, timeframe);
    if (candles.length < 50) return null;

    const result = analyzeDivergence(
      stock.symbol, stock.companyName, stock.exchange, timeframe, candles
    );

    if (isInsufficientOrNoDivergence(result)) return null;
    if (result.matched_count >= 1) return toScanResult(result);
    return null;
  } catch (e) {
    console.error(`[Divergence-Scan] Error scanning ${stock.symbol}:`, e);
    return null;
  }
}

const STRENGTH_ORDER: Record<Strength, number> = { very_strong: 4, strong: 3, moderate: 2, weak: 1 };

export async function scanAllStocks(
  timeframe: Timeframe,
  forceRefresh = false
): Promise<CacheData> {
  if (!forceRefresh) {
    const cached = getCachedDivergence(timeframe);
    if (cached) {
      const hoursSinceUpdate = (Date.now() - new Date(cached.lastUpdated).getTime()) / 3600000;
      if (hoursSinceUpdate < 24) {
        console.log(`[Divergence-Scan] Using cached data (${hoursSinceUpdate.toFixed(1)} hours old)`);
        return cached;
      }
    }
  }

  console.log(`[Divergence-Scan] Starting full market scan for ${timeframe}...`);
  const stocks = getUSStocks();
  const results: ScanResult[] = [];
  const batchSize = 10;
  let processed = 0;

  for (let i = 0; i < stocks.length; i += batchSize) {
    const batch = stocks.slice(i, i + batchSize);
    console.log(
      `[Divergence-Scan] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(stocks.length / batchSize)} (${processed}/${stocks.length})`
    );

    const batchResults = await Promise.all(batch.map(stock => scanStockForDivergence(stock, timeframe)));
    for (const r of batchResults) if (r) results.push(r);
    processed += batch.length;

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  results.sort((a, b) => {
    const diff = STRENGTH_ORDER[b.strength] - STRENGTH_ORDER[a.strength];
    if (diff !== 0) return diff;
    if (a.is_live !== b.is_live) return a.is_live ? 1 : -1;
    return b.matched_count - a.matched_count;
  });

  const cacheData: CacheData = { results, lastUpdated: new Date().toISOString(), timeframe };
  saveCache(timeframe, results);
  console.log(`[Divergence-Scan] Scan complete: ${results.length} stocks with divergence signals`);
  return cacheData;
}

export function filterDivergenceResults(
  results: ScanResult[],
  options: {
    type?: "bullish" | "bearish";
    exchange?: string;
    strength?: Strength;
    minStrength?: Strength;
    liveOnly?: boolean;
    confirmedOnly?: boolean;
  }
): ScanResult[] {
  let filtered = [...results];

  if (options.type) filtered = filtered.filter(r => r.divergence_type === options.type);
  if (options.exchange && options.exchange !== "all") filtered = filtered.filter(r => r.exchange === options.exchange);
  if (options.liveOnly) filtered = filtered.filter(r => r.is_live);
  if (options.confirmedOnly) filtered = filtered.filter(r => !r.is_live);

  if (options.minStrength) {
    const minLevel = STRENGTH_ORDER[options.minStrength];
    filtered = filtered.filter(r => STRENGTH_ORDER[r.strength] >= minLevel);
  } else if (options.strength) {
    filtered = filtered.filter(r => r.strength === options.strength);
  }

  return filtered;
}