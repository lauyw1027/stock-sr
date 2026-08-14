/**
 * spreadOpportunityScan.ts — 獨立價差機會掃描模組
 * 
 * 對同一批股票池，不預先綁定方向，兩個方向都跑一遍，
 * 直接排出「這批股票裡誰最適合做bear_call、誰最適合做bull_put」
 * 
 * 重點：
 * 1. getOptionChainWithDelta 只呼叫一次，結果共用給兩個方向
 * 2. 套用這輪討論確認過的參數設定
 * 3. 維持市場時段判斷與快取機制
 */

import { yahooFinance } from "./stocks";
import { ATHATLRecord } from "./stocks";
// Import types from creditSpreadScanner - these should be exported
import type { 
  SpreadDirection, 
  SpreadConfig, 
  SpreadCandidate, 
  RankedCandidate 
} from "./creditSpreadScanner";
// Import functions we need
import { calculateIVRank } from "./creditSpreadScanner";

// Duplicate OptionChainResult interface locally to avoid import issues
interface OptionContract {
  strike: number;
  expiration: string;
  impliedVolatility: number;
  bid: number;
  ask: number;
  openInterest: number;
}

interface OptionContractWithDelta extends OptionContract {
  delta: number;
}

interface OptionChainResult {
  calls: OptionContractWithDelta[];
  puts: OptionContractWithDelta[];
}

// ============ Optimized Configuration ============

// 這輪討論驗算過的參數組合
const OPTIMIZED_CONFIG: SpreadConfig = {
  direction: "bear_call" as const, // 預設方向，實際使用時會被覆蓋
  shortDeltaRange: { min: 0.12, max: 0.20 }, // 中點0.16，配合25% ROC門檻留有緩衝
  longStrikeOffsetPct: 4,
  minIVRank: 30, // bear_call 用 30
  minROC: 25,
  minBreakevenBufferPct: 6,
  minDaysToEarnings: 7,
};

// Bull Put 專用設定（更高 IV Rank 門檻）
const BULL_PUT_CONFIG: SpreadConfig = {
  ...OPTIMIZED_CONFIG,
  direction: "bull_put" as const,
  minIVRank: 35,
};

// Bear Call 專用設定
const BEAR_CALL_CONFIG: SpreadConfig = {
  ...OPTIMIZED_CONFIG,
  direction: "bear_call" as const,
  minIVRank: 30,
};

// ============ Type Definitions ============

export interface DualDirectionResult {
  symbol: string;
  companyName: string;
  bearCall: RankedCandidate | null;   // null代表這個方向沒有找到合適組合
  bullPut: RankedCandidate | null;
  bearCallRejectReason: string | null; // 記錄淘汰原因，方便debug跟前端顯示
  bullPutRejectReason: string | null;
}

// ============ US Market Hours Helper ============

/**
 * 美股正規交易時段判斷（與 creditSpreadScanner 相同）
 * 透過 FORCE_MARKET_OPEN 環境變數控制，只有明確設為 "true" 才會繞過時段判斷
 */
function isUSMarketHours(forceOpen: boolean = true): boolean {
  if (forceOpen) return true;
  const now = new Date();

  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });

  const parts = etFormatter.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const currentMinutes = hour * 60 + minute;
  const marketOpenMinutes = 9 * 60 + 30;
  const marketCloseMinutes = 16 * 60;

  return isWeekday && currentMinutes >= marketOpenMinutes && currentMinutes < marketCloseMinutes;
}

// ============ Cache Management ============

let cachedResults: { bestBearCalls: RankedCandidate[]; bestBullPuts: RankedCandidate[]; allResults: DualDirectionResult[]; lastUpdated: string } | null = null;
let cachedResultsTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// 用於驗證 getOptionChainWithDelta 只被呼叫一次
let optionChainCallCount = 0;

/**
 * 取得快取結果
 */
export function getCachedSpreadOpportunityResults(): { bestBearCalls: RankedCandidate[]; bestBullPuts: RankedCandidate[]; allResults: DualDirectionResult[]; lastUpdated: string } | null {
  return cachedResults;
}

/**
 * 取得 option chain 呼叫次數（用於驗證）
 */
export function getOptionChainCallCount(): number {
  return optionChainCallCount;
}

/**
 * 重置呼叫計數器（測試用）
 */
export function resetOptionChainCallCount(): void {
  optionChainCallCount = 0;
}

// ============ Option Chain Fetching (Reuse from creditSpreadScanner) ============

// 直接使用 creditSpreadScanner 裡的 getOptionChainWithDelta
// 但要包裝成可追蹤呼叫次數的版本
async function fetchOptionChainWithTracking(
  symbol: string
): Promise<OptionChainResult | null> {
  // Import dynamically to avoid circular dependency
  const { getOptionChainWithDelta } = await import("./creditSpreadScanner");
  
  optionChainCallCount++;
  console.log(`[SpreadOpportunity] getOptionChainWithDelta called for ${symbol}, total count: ${optionChainCallCount}`);
  
  return getOptionChainWithDelta(symbol);
}

// ============ Spread Strike Selection ============

/**
 * 選擇信用價差的履約價組合（從 creditSpreadScanner 複製過來以確保獨立運作）
 */
function selectSpreadStrikes(
  chain: OptionChainResult,
  direction: SpreadDirection,
  config: SpreadConfig,
  currentPrice: number,
  symbol: string
): SpreadCandidate | null {
  const { calls, puts } = chain;
  const { shortDeltaRange, longStrikeOffsetPct } = config;

  const MAX_BID_ASK_RATIO = 3; // ask超過bid的3倍視為價差過寬，報價不可靠

  if (direction === "bear_call") {
    // Bear Call Spread: 賣 OTM Call (delta 在區間內，履約價 > 現價)
    let wideBidAskFiltered = 0;
    const shortCalls = calls
      .filter(c => {
        // Delta 範圍檢查
        if (c.delta < shortDeltaRange.min || c.delta > shortDeltaRange.max) return false;
        if (c.strike <= currentPrice) return false;
        
        // bid-ask價差合理性檢查
        if (c.bid <= 0) return false; // short leg必須有實際報價，不能是0
        if (c.ask > 0 && c.ask / c.bid > MAX_BID_ASK_RATIO) {
          wideBidAskFiltered++;
          return false;
        }
        
        return true;
      })
      .sort((a, b) => Math.abs(a.delta - (shortDeltaRange.min + shortDeltaRange.max) / 2) - Math.abs(b.delta - (shortDeltaRange.min + shortDeltaRange.max) / 2));

    if (wideBidAskFiltered > 0) {
      console.log(`[SpreadOpportunity] ${symbol}: 過濾掉 ${wideBidAskFiltered} 個bear_call bid-ask價差過寬的合約`);
    }

    if (shortCalls.length === 0) {
      console.log(`[SpreadOpportunity] ${symbol}: 找不到符合 Delta 條件的 Short Call (bear_call)`);
      return null;
    }

    const shortCall = shortCalls[0];
    const longStrikeTarget = shortCall.strike * (1 + longStrikeOffsetPct / 100);

    const longCalls = calls
      .filter(c => c.strike > shortCall.strike)
      .sort((a, b) => Math.abs(a.strike - longStrikeTarget) - Math.abs(b.strike - longStrikeTarget));

    if (longCalls.length === 0) {
      console.log(`[SpreadOpportunity] ${symbol}: 找不到符合條件的 Long Call (bear_call)`);
      return null;
    }

    const longCall = longCalls[0];

    const rawNetCredit = shortCall.bid - longCall.ask;
    const rawMaxLoss = longCall.strike - shortCall.strike - rawNetCredit;
    
    if (rawMaxLoss <= 0) {
      console.error(`[SpreadOpportunity] ${symbol} bear_call maxLoss 計算異常 (${rawMaxLoss.toFixed(2)})，跳過`);
      return null;
    }
    
    const netCredit = Math.max(0, rawNetCredit);
    const maxLoss = Math.max(0, rawMaxLoss);
    const roc = maxLoss > 0 ? (netCredit / maxLoss) * 100 : 0;
    const breakevenPrice = shortCall.strike + netCredit;
    const breakevenBufferPct = Math.abs(breakevenPrice - currentPrice) / currentPrice * 100;

    return {
      direction: "bear_call",
      symbol: "",
      companyName: "",
      currentPrice,
      shortStrike: shortCall.strike,
      longStrike: longCall.strike,
      expiration: shortCall.expiration,
      netCredit: Math.max(0, netCredit),
      maxLoss: Math.max(0, maxLoss),
      roc,
      breakevenPrice,
      breakevenBufferPct,
    };
  } else {
    // Bull Put Spread: 賣 OTM Put (|delta| 在區間內，履約價 < 現價)
    let wideBidAskFiltered = 0;
    const shortPuts = puts
      .filter(p => {
        // Delta 範圍檢查
        if (Math.abs(p.delta) < shortDeltaRange.min || Math.abs(p.delta) > shortDeltaRange.max) return false;
        if (p.strike >= currentPrice) return false;
        
        // bid-ask價差合理性檢查
        if (p.bid <= 0) return false; // short leg必須有實際報價，不能是0
        if (p.ask > 0 && p.ask / p.bid > MAX_BID_ASK_RATIO) {
          wideBidAskFiltered++;
          return false;
        }
        
        return true;
      })
      .sort((a, b) => Math.abs(Math.abs(a.delta) - (shortDeltaRange.min + shortDeltaRange.max) / 2) - Math.abs(Math.abs(b.delta) - (shortDeltaRange.min + shortDeltaRange.max) / 2));

    if (wideBidAskFiltered > 0) {
      console.log(`[SpreadOpportunity] ${symbol}: 過濾掉 ${wideBidAskFiltered} 個bull_put bid-ask價差過寬的合約`);
    }

    if (shortPuts.length === 0) {
      console.log(`[SpreadOpportunity] ${symbol}: 找不到符合 Delta 條件的 Short Put (bull_put)`);
      return null;
    }

    const shortPut = shortPuts[0];
    const longStrikeTarget = shortPut.strike * (1 - longStrikeOffsetPct / 100);

    const longPuts = puts
      .filter(p => p.strike < shortPut.strike)
      .sort((a, b) => Math.abs(a.strike - longStrikeTarget) - Math.abs(b.strike - longStrikeTarget));

    if (longPuts.length === 0) {
      console.log(`[SpreadOpportunity] ${symbol}: 找不到符合條件的 Long Put (bull_put)`);
      return null;
    }

    const longPut = longPuts[0];

    const rawNetCredit = shortPut.bid - longPut.ask;
    const rawMaxLoss = shortPut.strike - longPut.strike - rawNetCredit;
    
    if (rawMaxLoss <= 0) {
      console.error(`[SpreadOpportunity] ${symbol} bull_put maxLoss 計算異常 (${rawMaxLoss.toFixed(2)})，跳過`);
      return null;
    }
    
    const netCredit = Math.max(0, rawNetCredit);
    const maxLoss = Math.max(0, rawMaxLoss);
    const roc = maxLoss > 0 ? (netCredit / maxLoss) * 100 : 0;
    const breakevenPrice = shortPut.strike - netCredit;
    const breakevenBufferPct = Math.abs(breakevenPrice - currentPrice) / currentPrice * 100;

    return {
      direction: "bull_put",
      symbol: "",
      companyName: "",
      currentPrice,
      shortStrike: shortPut.strike,
      longStrike: longPut.strike,
      expiration: shortPut.expiration,
      netCredit: Math.max(0, netCredit),
      maxLoss: Math.max(0, maxLoss),
      roc,
      breakevenPrice,
      breakevenBufferPct,
    };
  }
}

// ============ Scoring Function ============

/**
 * 評分候選人（與 creditSpreadScanner 相同的邏輯）
 */
function scoreSpreadCandidate(
  candidate: SpreadCandidate,
  ivRank: number | null,
  config: SpreadConfig
): number | null {
  // 硬性淘汰條件
  if (candidate.roc <= 0) {
    console.log(`[SpreadOpportunity] ${candidate.symbol} ROC 為 0 或負值，已跳過`);
    return null;
  }
  
  if (candidate.roc < config.minROC) {
    console.log(`[SpreadOpportunity] ${candidate.symbol} ROC ${candidate.roc.toFixed(1)}% 低於門檻 ${config.minROC}%，被淘汰`);
    return null;
  }

  if (candidate.breakevenBufferPct < config.minBreakevenBufferPct) {
    console.log(`[SpreadOpportunity] ${candidate.symbol} 損益平衡緩衝 ${candidate.breakevenBufferPct.toFixed(1)}% 低於門檻 ${config.minBreakevenBufferPct}%，被淘汰`);
    return null;
  }

  if (ivRank === null || ivRank < config.minIVRank) {
    console.log(`[SpreadOpportunity] ${candidate.symbol} IV Rank ${ivRank ?? "N/A"} 低於門檻 ${config.minIVRank}，被淘汰`);
    return null;
  }

  // 加權評分：ROC: 40%, 緩衝距離: 30%, IV Rank: 30%
  const rocScore = Math.min(100, candidate.roc / config.minROC * 50);
  const bufferScore = Math.min(100, candidate.breakevenBufferPct / config.minBreakevenBufferPct * 50);
  const ivScore = ivRank;

  const totalScore = 
    rocScore * 0.40 +
    bufferScore * 0.30 +
    ivScore * 0.30;

  return Math.round(totalScore);
}

// ============ Process Single Stock for Both Directions ============

/**
 * 對同一支股票，兩個方向都算一次（option chain 只抓一次）
 */
async function scanBothDirectionsForTicker(
  stock: ATHATLRecord
): Promise<DualDirectionResult> {
  const { symbol, company_name, last_close } = stock;
  
  // 只抓一次 option chain
  const optionChain = await fetchOptionChainWithTracking(symbol);
  
  if (!optionChain) {
    console.log(`[SpreadOpportunity] ${symbol} 無法取得選擇權鏈資料`);
    return {
      symbol,
      companyName: company_name,
      bearCall: null,
      bullPut: null,
      bearCallRejectReason: "無法取得選擇權鏈資料",
      bullPutRejectReason: "無法取得選擇權鏈資料",
    };
  }

  const chain = optionChain;

  // ============ Bear Call ============
  let bearCallResult: RankedCandidate | null = null;
  let bearCallRejectReason: string | null = null;
  
  try {
    const bearCallCandidate = selectSpreadStrikes(chain, "bear_call", BEAR_CALL_CONFIG, last_close, symbol);
    
    if (bearCallCandidate) {
      const ivRank = await calculateIVRank(symbol);
      const score = scoreSpreadCandidate(bearCallCandidate, ivRank, BEAR_CALL_CONFIG);
      
      if (score !== null) {
        bearCallResult = {
          ...bearCallCandidate,
          symbol,
          companyName: company_name,
          score,
          ivRank,
          daysToEarnings: stock.days_to_earnings,
        };
      } else {
        bearCallRejectReason = "不符合評分門檻 (ROC/IV/Buffer)";
      }
    } else {
      bearCallRejectReason = "找不到合適的履約價組合";
    }
  } catch (e: any) {
    bearCallRejectReason = `計算錯誤: ${e.message}`;
  }

  // ============ Bull Put ============
  let bullPutResult: RankedCandidate | null = null;
  let bullPutRejectReason: string | null = null;
  
  try {
    const bullPutCandidate = selectSpreadStrikes(chain, "bull_put", BULL_PUT_CONFIG, last_close, symbol);
    
    if (bullPutCandidate) {
      const ivRank = await calculateIVRank(symbol);
      const score = scoreSpreadCandidate(bullPutCandidate, ivRank, BULL_PUT_CONFIG);
      
      if (score !== null) {
        bullPutResult = {
          ...bullPutCandidate,
          symbol,
          companyName: company_name,
          score,
          ivRank,
          daysToEarnings: stock.days_to_earnings,
        };
      } else {
        bullPutRejectReason = "不符合評分門檻 (ROC/IV/Buffer)";
      }
    } else {
      bullPutRejectReason = "找不到合適的履約價組合";
    }
  } catch (e: any) {
    bullPutRejectReason = `計算錯誤: ${e.message}`;
  }

  return {
    symbol,
    companyName: company_name,
    bearCall: bearCallResult,
    bullPut: bullPutResult,
    bearCallRejectReason,
    bullPutRejectReason,
  };
}

// ============ Main Scan Function ============

/**
 * 對傳入的股票池（不區分 ATH/ATL），兩個方向都跑一遍
 */
export async function scanUniverseForBestSpreadOpportunities(
  tickers: ATHATLRecord[]
): Promise<{ bestBearCalls: RankedCandidate[]; bestBullPuts: RankedCandidate[]; allResults: DualDirectionResult[] }> {
  
  // 防禦性補強：依symbol去重，避免呼叫端漏掉去重
  const uniqueTickers = Array.from(new Map(tickers.map((t) => [t.symbol, t])).values());
  if (uniqueTickers.length !== tickers.length) {
    console.warn(`[SpreadOpportunity] 輸入的tickers有重複，${tickers.length} -> ${uniqueTickers.length}（已去重）`);
  }
  
  // 財報過濾（兩個方向共用同一份 minDaysToEarnings 邏輯）
  const filtered = uniqueTickers.filter((t) => t.days_to_earnings === null || t.days_to_earnings > OPTIMIZED_CONFIG.minDaysToEarnings);
  console.log(`[SpreadOpportunity] 輸入 ${uniqueTickers.length} 支股票，財報過濾後剩 ${filtered.length} 支`);

  const allResults: DualDirectionResult[] = [];
  const BATCH_SIZE = 10;

  // 重置計數器
  resetOptionChainCallCount();

  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const batch = filtered.slice(i, i + BATCH_SIZE);
    console.log(`[SpreadOpportunity] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(filtered.length / BATCH_SIZE)}`);

    const batchResults = await Promise.all(batch.map((t) => scanBothDirectionsForTicker(t)));

    allResults.push(...batchResults);

    // 每批之間延遲，避免觸發 Yahoo rate limit
    if (i + BATCH_SIZE < filtered.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.log(`[SpreadOpportunity] 完成 scanBothDirectionsForTicker，getOptionChainWithDelta 總呼叫次數: ${optionChainCallCount}`);

  // 分離兩個方向的結果並排序
  const bestBearCalls = allResults
    .map((r) => r.bearCall)
    .filter((c): c is RankedCandidate => c !== null)
    .sort((a, b) => b.score - a.score);

  const bestBullPuts = allResults
    .map((r) => r.bullPut)
    .filter((c): c is RankedCandidate => c !== null)
    .sort((a, b) => b.score - a.score);

  console.log(`[SpreadOpportunity] 找到 ${bestBearCalls.length} 個 bear_call 候選，${bestBullPuts.length} 個 bull_put 候���`);

  return { bestBearCalls, bestBullPuts, allResults };
}

// ============ Main Entry Point with Caching ============

/**
 * 對外的主要掃描函數，包含市場時段判斷與快取
 */
export async function scanSpreadOpportunities(
  stocks: ATHATLRecord[]
): Promise<{ bestBearCalls: RankedCandidate[]; bestBullPuts: RankedCandidate[]; allResults: DualDirectionResult[]; lastUpdated: string; marketStatus: "open" | "closed"; optionChainCallCount: number }> {
  const now = Date.now();

  // 透過環境變數控制是否繞過市場時段判斷
  const forceOpen = process.env.FORCE_MARKET_OPEN === "true";
  
  // 檢查市場是否開市
  const marketIsOpen = isUSMarketHours(forceOpen);
  if (!marketIsOpen) {
    console.log("[SpreadOpportunity] Market is closed — skipping scan, returning cached results if available");
    
    if (cachedResults) {
      return { ...cachedResults, marketStatus: "closed", optionChainCallCount };
    }
    
    return {
      bestBearCalls: [],
      bestBullPuts: [],
      allResults: [],
      lastUpdated: new Date().toISOString(),
      marketStatus: "closed",
      optionChainCallCount,
    };
  }

  // 檢查快取
  if (cachedResults && (now - cachedResultsTime) < CACHE_TTL_MS) {
    console.log(`[SpreadOpportunity] Using cached results (age: ${Math.round((now - cachedResultsTime) / 1000)}s)`);
    return { ...cachedResults, marketStatus: "open", optionChainCallCount };
  }

  console.log(`[SpreadOpportunity] Starting fresh scan...`);

  // 執行掃描
  const result = await scanUniverseForBestSpreadOpportunities(stocks);

  // 更新快取
  cachedResults = {
    ...result,
    lastUpdated: new Date().toISOString(),
  };
  cachedResultsTime = now;

  return { ...cachedResults, marketStatus: "open", optionChainCallCount };
}

/**
 * 清除快取
 */
export function clearSpreadOpportunityCache(): void {
  cachedResults = null;
  cachedResultsTime = 0;
  console.log("[SpreadOpportunity] Cache cleared");
}