/**
 * creditSpreadScanner.ts — 信用價差推薦模組
 * 
 * 歷史新高 (ATH) 股票 → Bear Call Spread
 * 歷史新低 (ATL) 股票 → Bull Put Spread
 * 
 * 方向抽象化：同一套邏輯支援兩種價差策略
 */

import { yahooFinance } from "./stocks";
import { ATHATLRecord } from "./stocks";
import { analyzeDivergence, fetchCandles, type DivergenceResult, type Timeframe } from "./divergence";
import { buildZones, computeIndicators, type Indicators } from "./analysis";

// ============ Type Definitions ============

export type SpreadDirection = "bear_call" | "bull_put";

export interface SpreadConfig {
  direction: SpreadDirection;
  shortDeltaRange: { min: number; max: number };   // e.g., 0.20–0.35
  longStrikeOffsetPct: number;                     // e.g., 8%
  minIVRank: number;                               // e.g., 30
  minROC: number;                                  // e.g., 25 (%)
  minBreakevenBufferPct: number;                   // e.g., 4 (%)
  minDaysToEarnings: number;                       // e.g., 7
}

export interface OptionContract {
  strike: number;
  expiration: string;
  impliedVolatility: number;
  bid: number;
  ask: number;
  openInterest: number;
}

export interface OptionContractWithDelta extends OptionContract {
  delta: number;
}

export interface SpreadCandidate {
  direction: SpreadDirection;
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
}

export interface RankedCandidate extends SpreadCandidate {
  score: number;
  reversalSignal: {
    confirmed: boolean;
    strength: number;
  };
  ivRank: number | null;
  daysToEarnings: number | null;
}

// Default configurations for each style
const STYLE_CONFIGS: Record<"conservative" | "balanced" | "aggressive", { shortDeltaRange: { min: number; max: number } }> = {
  conservative: { shortDeltaRange: { min: 0.15, max: 0.20 } },
  balanced: { shortDeltaRange: { min: 0.20, max: 0.30 } },
  aggressive: { shortDeltaRange: { min: 0.30, max: 0.40 } },
};

// Default SpreadConfigs for each direction
const DEFAULT_BEAR_CALL_CONFIG: SpreadConfig = {
  direction: "bear_call",
  shortDeltaRange: { min: 0.20, max: 0.35 },
  longStrikeOffsetPct: 8,
  minIVRank: 30,
  minROC: 25,
  minBreakevenBufferPct: 4,
  minDaysToEarnings: 7,
};

const DEFAULT_BULL_PUT_CONFIG: SpreadConfig = {
  direction: "bull_put",
  shortDeltaRange: { min: 0.20, max: 0.35 },
  longStrikeOffsetPct: 8,
  minIVRank: 35, // Higher for bull_put
  minROC: 25,
  minBreakevenBufferPct: 4,
  minDaysToEarnings: 7,
};

// ============ Black-Scholes Delta Calculation ============

// Approximation of standard normal CDF using error function
function standardNormalCDF(x: number): number {
  // Using Abramowitz and Stegun approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

// Calculate d1 in Black-Scholes
function calculateD1(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return 0;
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

export function calculateCallDelta(S: number, K: number, T: number, r: number = 0.045, sigma: number): number {
  // S = spot price, K = strike price, T = time to expiration in years, r = risk-free rate, sigma = volatility
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  
  const d1 = calculateD1(S, K, T, r, sigma);
  return standardNormalCDF(d1);
}

export function calculatePutDelta(callDelta: number): number {
  return callDelta - 1;
}

// ============ Option Chain Fetch with Retry ============

/**
 * 嘗試取得選擇權資料，包含重試機制
 */
async function fetchOptionsWithRetry(symbol: string, maxRetries = 1): Promise<any | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await yahooFinance.options(symbol);

      // 第一次呼叫只需要到期日清單，檢查 expirationDates
      if (raw?.expirationDates?.length > 0) {
        if (attempt > 0) {
          console.log(`[OptionChain] ${symbol} 第 ${attempt + 1} 次嘗試成功取得資料`);
        }
        return raw;
      }

      if (attempt < maxRetries) {
        console.log(`[OptionChain] ${symbol} 第 ${attempt + 1} 次嘗試無到期日資料，等待後重試...`);
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      if (attempt < maxRetries) {
        console.log(`[OptionChain] ${symbol} 第 ${attempt + 1} 次嘗試發生錯誤，等待後重試:`, e);
        await new Promise(r => setTimeout(r, 1500));
      } else {
        console.error(`[OptionChain] ${symbol} 重試 ${maxRetries} 次後仍失敗:`, e);
      }
    }
  }
  return null;
}

// ============ Candidate Filtering Functions ============

/**
 * 分流候選股票：ATH/52W_ATH → bear_call，ATL/52W_ATL → bull_put
 */
export function getCandidatesByDirection(stocks: ATHATLRecord[]): {
  bearCallCandidates: ATHATLRecord[];
  bullPutCandidates: ATHATLRecord[];
} {
  const bearCallCandidates: ATHATLRecord[] = [];
  const bullPutCandidates: ATHATLRecord[] = [];

  for (const stock of stocks) {
    if (stock.list_type === "ATH" || stock.list_type === "52W_ATH") {
      bearCallCandidates.push(stock);
    } else if (stock.list_type === "ATL" || stock.list_type === "52W_ATL") {
      bullPutCandidates.push(stock);
    }
  }

  return { bearCallCandidates, bullPutCandidates };
}

/**
 * 根據 config 過濾候選池中的財報日期
 */
export function filterByEarnings(
  candidates: ATHATLRecord[],
  config: SpreadConfig
): { filtered: ATHATLRecord[]; removed: string[] } {
  const filtered: ATHATLRecord[] = [];
  const removed: string[] = [];

  for (const stock of candidates) {
    const daysToEarnings = stock.days_to_earnings;
    
    // days_to_earnings === null 視為通過（沒有即將到來的財報）
    // days_to_earnings > config.minDaysToEarnings 才通過
    if (daysToEarnings === null || daysToEarnings > config.minDaysToEarnings) {
      filtered.push(stock);
    } else {
      removed.push(stock.symbol);
      console.log(`[CreditSpread] ${stock.symbol} 因財報將近排除 (距離 ${daysToEarnings} 天)`);
    }
  }

  return { filtered, removed };
}

// ============ Technical Reversal Signal Confirmation ============

interface ReversalSignalResult {
  confirmed: boolean;
  strength: number;
  reason: string;
}

/**
 * 確認技術面反轉訊號
 * 
 * @param stock ATHATLRecord 股票資料
 * @param direction bear_call 需要頂部背馳或跌破支撐；bull_put 需要底部背馳或站回壓力
 */
export async function confirmReversalSignal(
  stock: ATHATLRecord,
  direction: SpreadDirection
): Promise<ReversalSignalResult> {
  try {
    // 抓取歷史 K 線資料 (1d timeframe)
    const candles = await fetchCandles(stock.symbol, "1d");
    
    if (candles.length < 50) {
      return { confirmed: false, strength: 0, reason: "資料不足" };
    }

    const lastClose = candles[candles.length - 1].close;

    // 執行背馳分析
    const divergenceResult = analyzeDivergence(
      stock.symbol,
      stock.company_name,
      stock.exchange,
      "1d",
      candles
    );

    // 計算支撐/阻力
    const indicators = computeIndicators(candles);
    const { support, resistance } = buildZones(indicators, lastClose);

    const isBearCall = direction === "bear_call";
    const isBullPut = direction === "bull_put";

    // 紀錄檢測到的訊號
    const signals: string[] = [];
    let signalStrength = 0;

    // 1. 背馳偵測
    if (!("status" in divergenceResult)) {
      const divType = divergenceResult.divergence_type;
      const strength = divergenceResult.strength;
      const strengthMap: Record<string, number> = {
        weak: 20,
        moderate: 40,
        strong: 70,
        very_strong: 100,
      };
      const strengthValue = strengthMap[strength] || 0;

      if (isBearCall && divType === "bearish") {
        signals.push(`頂部背馳 (${divergenceResult.matched_indicators.join(", ")})`);
        signalStrength = Math.max(signalStrength, strengthValue);
      }

      if (isBullPut && divType === "bullish") {
        signals.push(`底部背馳 (${divergenceResult.matched_indicators.join(", ")})`);
        signalStrength = Math.max(signalStrength, strengthValue);
      }
    }

    // 2. 價格與支撐/阻力關係
    if (isBearCall && support.length > 0) {
      const nearestSupport = support[0];
      // 如果價格跌破近期支撐視為轉弱訊號
      if (lastClose < nearestSupport.center) {
        signals.push(`跌破支撐區 ${nearestSupport.center.toFixed(2)}`);
        signalStrength = Math.max(signalStrength, 60);
      }
    }

    if (isBullPut && resistance.length > 0) {
      const nearestResistance = resistance[0];
      // 如果價格站回近期壓力視為轉強訊號
      if (lastClose > nearestResistance.center) {
        signals.push(`站回壓力區 ${nearestResistance.center.toFixed(2)}`);
        signalStrength = Math.max(signalStrength, 60);
      }
    }

    // K線型態偵測待補（目前僅用背馳與支撐/阻力）
    if (isBullPut && signals.length === 0) {
      console.log(`[CreditSpread] ${stock.symbol} (bull_put) 無明確反轉訊號，需自行評估`);
    }

    const confirmed = signals.length > 0;
    return {
      confirmed,
      strength: signalStrength,
      reason: signals.length > 0 ? signals.join("; ") : "無明確反轉訊號",
    };
  } catch (e) {
    console.error(`[CreditSpread] Error confirming reversal signal for ${stock.symbol}:`, e);
    return { confirmed: false, strength: 0, reason: "分析過程發生錯誤" };
  }
}

// ============ IV Rank Calculation ============

const hvCache: Map<string, { rank: number; cachedAt: number }> = new Map();
const HV_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * 計算歷史波動率 (HV) 的百分位數作為 IV Rank 的替代指標
 * 
 * Yahoo Finance 沒有提供歷史 IV 資料，所以使用過去一年的日報酬率計算 HV，
 * 然後與過去 3 年的 HV 比較計算百分位。
 */
export async function calculateIVRank(symbol: string): Promise<number | null> {
  // 檢查快取
  const cached = hvCache.get(symbol);
  const now = Date.now();
  if (cached && (now - cached.cachedAt) < HV_CACHE_TTL_MS) {
    return cached.rank;
  }

  try {
    // 抓取過去 3 年資料
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 3);

    const chart = await yahooFinance.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval: "1d",
    });

    const quotes = chart?.quotes ?? [];
    if (quotes.length < 252) { // 需要至少一年的交易日資料
      console.log(`[CreditSpread] ${symbol} 歷史資料不足，無法計算 HV Rank`);
      return null;
    }

    // 計算每日報酬率
    const returns: number[] = [];
    for (let i = 1; i < quotes.length; i++) {
      const prevClose = quotes[i - 1].close;
      const currClose = quotes[i].close;
      if (prevClose && currClose && prevClose > 0) {
        returns.push(Math.log(currClose / prevClose));
      }
    }

    if (returns.length < 252) {
      return null;
    }

    // 計算年度化波動率 (假設252個交易日)
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const hv = Math.sqrt(variance * 252);

    // 計算滾動 20 日區間的 HV，形成樣本分布
    const rollingHV: number[] = [];
    const windowSize = 20;
    
    for (let i = windowSize; i <= returns.length; i++) {
      const windowReturns = returns.slice(i - windowSize, i);
      const windowAvg = windowReturns.reduce((a, b) => a + b, 0) / windowReturns.length;
      const windowVar = windowReturns.reduce((sum, r) => sum + Math.pow(r - windowAvg, 2), 0) / windowReturns.length;
      const windowHV = Math.sqrt(windowVar * 252);
      rollingHV.push(windowHV);
    }

    if (rollingHV.length < 50) {
      return null;
    }

    // 計算百分位：当前 HV 在歷史滾動 HV 中的位置
    const sortedHV = [...rollingHV].sort((a, b) => a - b);
    let rank = 0;
    for (const h of sortedHV) {
      if (hv >= h) rank++;
    }
    const ivRank = Math.round((rank / sortedHV.length) * 100);

    // 快取結果
    hvCache.set(symbol, { rank: ivRank, cachedAt: now });

    return ivRank;
  } catch (e) {
    console.error(`[CreditSpread] Error calculating IV Rank for ${symbol}:`, e);
    return null;
  }
}

// ============ Option Chain Fetching ============

interface ExpirationOption {
  expiration: string;
  calls: OptionContract[];
  puts: OptionContract[];
}

interface OptionChainResult {
  calls: OptionContractWithDelta[];
  puts: OptionContractWithDelta[];
}

/**
 * 取得選擇權鏈並計算 Delta
 * 
 * @param symbol 股票代號
 * @param expirationRange 到期日範圍（天數）
 */
export async function getOptionChainWithDelta(
  symbol: string,
  expirationRange: { minDays: number; maxDays: number } = { minDays: 21, maxDays: 49 }
): Promise<OptionChainResult | null> {
  try {
    // 階段一：先抓完整到期日清單
    const initial = await fetchOptionsWithRetry(symbol);
    
    if (!initial) {
      console.warn(`[OptionChain] ${symbol} 無法取得初始選擇權資料`);
      return null;
    }

    const allExpirationDates = initial.expirationDates ?? [];
    console.log(`[OptionChain] ${symbol} 共有 ${allExpirationDates.length} 個可選到期日`);

    if (allExpirationDates.length === 0) {
      console.warn(`[OptionChain] ${symbol} 沒有任何可選到期日`);
      return null;
    }

    // 從清單中找出落在指定範圍內、且最接近範圍中間值的到期日
    const now = Date.now();
    const targetMidDays = (expirationRange.minDays + expirationRange.maxDays) / 2;

    const candidatesInRange = allExpirationDates
      .map((d: any) => {
        const expDate = new Date(d);
        const daysUntil = Math.round((expDate.getTime() - now) / (1000 * 60 * 60 * 24));
        return { date: expDate, daysUntil };
      })
      .filter(({ daysUntil }) => daysUntil >= expirationRange.minDays && daysUntil <= expirationRange.maxDays)
      .sort((a, b) => Math.abs(a.daysUntil - targetMidDays) - Math.abs(b.daysUntil - targetMidDays));

    console.log(`[OptionChain] ${symbol} 篩選後剩 ${candidatesInRange.length} 個到期日落在 ${expirationRange.minDays}-${expirationRange.maxDays} 天範圍內`);

    if (candidatesInRange.length === 0) {
      console.warn(`[OptionChain] ${symbol} 沒有到期日落在指定範圍內（範圍太窄或該股票到期日分布特殊）`);
      return null;
    }

    const chosenExpiration = candidatesInRange[0].date;

    // 階段二：用挑選出的到期日，重新呼叫拿到該日期真正的calls/puts
    const specific = await yahooFinance.options(symbol, { date: chosenExpiration });
    const expirationData = specific.options?.[0];

    if (!expirationData || !expirationData.calls || !expirationData.puts) {
      console.warn(`[OptionChain] ${symbol} 指定到期日 ${chosenExpiration.toISOString()} 沒有合約資料`);
      return null;
    }

    const currentPrice = specific.quote?.regularMarketPrice;
    if (!currentPrice) {
      console.log(`[CreditSpread] ${symbol} 無法取得目前股價`);
      return null;
    }

    // 印出 impliedVolatility 原始數值範例以確認單位
    const sampleCall = expirationData.calls.find((c: any) => c.impliedVolatility != null);
    if (sampleCall) {
      const sampleT = (chosenExpiration.getTime() - now2.getTime()) / (365 * 24 * 60 * 60 * 1000);
      const sampleDelta = calculateCallDelta(currentPrice, sampleCall.strike, sampleT, r, sampleCall.impliedVolatility);
      console.log(`[OptionChain] ${symbol} impliedVolatility 範例: ${sampleCall.impliedVolatility} (strike: ${sampleCall.strike}, 對應Delta: ${sampleDelta.toFixed(4)})`);
    }

    const now2 = new Date();
    const r = 0.045; // TODO: 未來可改成動態抓取無風險利率

    const MIN_VALID_IV = 0.02; // 低於此門檻視為Yahoo的無效佔位值

    const processContracts = (contracts: any[], isPut: boolean): OptionContractWithDelta[] => {
      return contracts
        .filter((c) => {
          // 過濾條件一：IV必須是合理數值，不能是Yahoo的佔位假值
          const iv = c.impliedVolatility ?? 0;
          // Yahoo 回傳的 IV 已經是小數格式（0.35 = 35%），直接使用
          if (!iv || iv < MIN_VALID_IV) {
            return false;
          }

          // 過濾條件二：至少要有基本流動性
          // (openInterest > 0 或 bid > 0，避免選到完全沒人掛單的合約)
          const hasLiquidity = (c.openInterest ?? 0) > 0 || (c.bid ?? 0) > 0;
          if (!hasLiquidity) {
            return false;
          }

          return true;
        })
        .map((c) => {
          const T = (chosenExpiration.getTime() - now2.getTime()) / (365 * 24 * 60 * 60 * 1000);
          const sigma = c.impliedVolatility; // Yahoo 回傳的 IV 已經是小數格式（0.35 = 35%），不需要額外轉換
          
          const callDelta = calculateCallDelta(currentPrice, c.strike, T, r, sigma);
          const delta = isPut ? calculatePutDelta(callDelta) : callDelta;

          return { ...c, delta };
        })
        .filter((c) => c.delta !== 0 && isFinite(c.delta));
    };

    // 加入診斷log，統計過濾前後的合約數量
    const rawCallsCount = expirationData.calls.length;
    const rawPutsCount = expirationData.puts.length;
    const calls = processContracts(expirationData.calls, false);
    const puts = processContracts(expirationData.puts, true);

    console.log(`[OptionChain] ${symbol} calls: ${rawCallsCount} -> ${calls.length} (過濾IV異常值/無流動性後), puts: ${rawPutsCount} -> ${puts.length}`);

    if (calls.length === 0 && puts.length === 0) {
      console.warn(`[OptionChain] ${symbol} 過濾後沒有任何有效合約，可能是該股票選擇權市場本身流動性不足`);
      return null;
    }

    return { calls, puts };

  } catch (e) {
    console.error(`[OptionChain] ${symbol} 發生例外:`, e);
    return null;
  }
}

// ============ Spread Strike Selection ============

/**
 * 選擇信用價差的履約價組合
 */
export function selectSpreadStrikes(
  chain: OptionChainResult,
  direction: SpreadDirection,
  config: SpreadConfig,
  currentPrice: number
): SpreadCandidate | null {
  const { calls, puts } = chain;
  const { shortDeltaRange, longStrikeOffsetPct } = config;

  if (direction === "bear_call") {
    // Bear Call Spread: 賣 OTM Call (delta 在區間內，履約價 > 現價)
    const shortCalls = calls
      .filter(c => c.delta >= shortDeltaRange.min && c.delta <= shortDeltaRange.max && c.strike > currentPrice)
      .sort((a, b) => Math.abs(a.delta - (shortDeltaRange.min + shortDeltaRange.max) / 2) - Math.abs(b.delta - (shortDeltaRange.min + shortDeltaRange.max) / 2));

    if (shortCalls.length === 0) {
      console.log(`[CreditSpread] 找不到符合 Delta 條件的 Short Call (bear_call)`);
      return null;
    }

    const shortCall = shortCalls[0];
    const longStrikeTarget = shortCall.strike * (1 + longStrikeOffsetPct / 100);

    // 找 Long Call (履約價最接近目標)
    const longCalls = calls
      .filter(c => c.strike > shortCall.strike)
      .sort((a, b) => Math.abs(a.strike - longStrikeTarget) - Math.abs(b.strike - longStrikeTarget));

    if (longCalls.length === 0) {
      console.log(`[CreditSpread] 找不到符合條件的 Long Call (bear_call)`);
      return null;
    }

    const longCall = longCalls[0];

    const netCredit = shortCall.bid - longCall.ask;
    const maxLoss = longCall.strike - shortCall.strike - netCredit;
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
    const shortPuts = puts
      .filter(p => Math.abs(p.delta) >= shortDeltaRange.min && Math.abs(p.delta) <= shortDeltaRange.max && p.strike < currentPrice)
      .sort((a, b) => Math.abs(Math.abs(a.delta) - (shortDeltaRange.min + shortDeltaRange.max) / 2) - Math.abs(Math.abs(b.delta) - (shortDeltaRange.min + shortDeltaRange.max) / 2));

    if (shortPuts.length === 0) {
      console.log(`[CreditSpread] 找不到符合 Delta 條件的 Short Put (bull_put)`);
      return null;
    }

    const shortPut = shortPuts[0];
    const longStrikeTarget = shortPut.strike * (1 - longStrikeOffsetPct / 100);

    // 找 Long Put (履約價最接近目標)
    const longPuts = puts
      .filter(p => p.strike < shortPut.strike)
      .sort((a, b) => Math.abs(a.strike - longStrikeTarget) - Math.abs(b.strike - longStrikeTarget));

    if (longPuts.length === 0) {
      console.log(`[CreditSpread] 找不到符合條件的 Long Put (bull_put)`);
      return null;
    }

    const longPut = longPuts[0];

    const netCredit = shortPut.bid - longPut.ask;
    const maxLoss = longPut.strike - shortPut.strike - netCredit;
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
 * 綜合評分候選人
 * 
 * 硬性淘汰條件：
 * - direction === "bull_put" 且 reversalSignal.confirmed === false
 * - candidate.roc < config.minROC
 * - candidate.breakevenBufferPct < config.minBreakevenBufferPct
 * - ivRank === null || ivRank < config.minIVRank
 */
export function scoreSpreadCandidate(
  candidate: SpreadCandidate,
  reversalSignal: { confirmed: boolean; strength: number },
  ivRank: number | null,
  direction: SpreadDirection,
  config: SpreadConfig
): number | null {
  // 硬性淘汰條件
  if (direction === "bull_put" && !reversalSignal.confirmed) {
    console.log(`[CreditSpread] ${candidate.symbol} bull_put 方向無反轉訊號，被淘汰`);
    return null;
  }

  if (candidate.roc < config.minROC) {
    console.log(`[CreditSpread] ${candidate.symbol} ROC ${candidate.roc.toFixed(1)}% 低於門檻 ${config.minROC}%，被淘汰`);
    return null;
  }

  if (candidate.breakevenBufferPct < config.minBreakevenBufferPct) {
    console.log(`[CreditSpread] ${candidate.symbol} 損益平衡緩衝 ${candidate.breakevenBufferPct.toFixed(1)}% 低於門檻 ${config.minBreakevenBufferPct}%，被淘汰`);
    return null;
  }

  if (ivRank === null || ivRank < config.minIVRank) {
    console.log(`[CreditSpread] ${candidate.symbol} IV Rank ${ivRank ?? "N/A"} 低於門檻 ${config.minIVRank}，被淘汰`);
    return null;
  }

  // 加權評分
  // ROC: 30%, 緩衝距離: 25%, IV Rank: 25%, 技術訊號: 20%
  const rocScore = Math.min(100, candidate.roc / config.minROC * 50); // 超過門檻 2 倍得滿分
  const bufferScore = Math.min(100, candidate.breakevenBufferPct / config.minBreakevenBufferPct * 50);
  const ivScore = ivRank; // 本身就是 0-100
  const signalScore = reversalSignal.strength;

  const totalScore = 
    rocScore * 0.30 +
    bufferScore * 0.25 +
    ivScore * 0.25 +
    signalScore * 0.20;

  return Math.round(totalScore);
}

// ============ Main Scan Function with Caching ============

let cachedResults: { bearCallSpreads: RankedCandidate[]; bullPutSpreads: RankedCandidate[]; lastUpdated: string } | null = null;
let cachedResultsTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * 主掃描函數
 */
export async function scanCreditSpreadOpportunities(
  stocks: ATHATLRecord[],
  style: "conservative" | "balanced" | "aggressive" = "balanced"
): Promise<{ bearCallSpreads: RankedCandidate[]; bullPutSpreads: RankedCandidate[]; lastUpdated: string }> {
  const now = Date.now();

  // 檢查快取
  if (cachedResults && (now - cachedResultsTime) < CACHE_TTL_MS) {
    console.log(`[CreditSpread] Using cached results (age: ${Math.round((now - cachedResultsTime) / 1000)}s)`);
    return cachedResults;
  }

  console.log(`[CreditSpread] Starting scan with style: ${style}`);

  // 取得風格對應的 Delta 範圍
  const deltaRange = STYLE_CONFIGS[style].shortDeltaRange;

  // 建立兩個方向的 config
  const bearCallConfig: SpreadConfig = {
    ...DEFAULT_BEAR_CALL_CONFIG,
    shortDeltaRange: deltaRange,
  };

  const bullPutConfig: SpreadConfig = {
    ...DEFAULT_BULL_PUT_CONFIG,
    shortDeltaRange: deltaRange,
  };

  // 1. 分流候選股票
  const { bearCallCandidates, bullPutCandidates } = getCandidatesByDirection(stocks);
  console.log(`[CreditSpread] Initial candidates - Bear Call: ${bearCallCandidates.length}, Bull Put: ${bullPutCandidates.length}`);

  // 2. 財報過濾
  const filteredBearCall = filterByEarnings(bearCallCandidates, bearCallConfig);
  const filteredBullPut = filterByEarnings(bullPutCandidates, bullPutConfig);
  console.log(`[CreditSpread] After earnings filter - Bear Call: ${filteredBearCall.filtered.length}, Bull Put: ${filteredBullPut.filtered.length}`);

  // 3. 批量處理 Bear Call 候選
  const bearCallResults: RankedCandidate[] = await processCandidates(
    filteredBearCall.filtered,
    "bear_call",
    bearCallConfig
  );

  // 4. 批量處理 Bull Put 候選
  const bullPutResults: RankedCandidate[] = await processCandidates(
    filteredBullPut.filtered,
    "bull_put",
    bullPutConfig
  );

  // 5. 按分數排序
  bearCallResults.sort((a, b) => b.score - a.score);
  bullPutResults.sort((a, b) => b.score - a.score);

  const results = {
    bearCallSpreads: bearCallResults,
    bullPutSpreads: bullPutResults,
    lastUpdated: new Date().toISOString(),
  };

  // 更新快取
  cachedResults = results;
  cachedResultsTime = now;

  console.log(`[CreditSpread] Scan complete - Bear Call: ${bearCallResults.length}, Bull Put: ${bullPutResults.length}`);

  return results;
}

/**
 * 批量處理候選股票
 */
async function processCandidates(
  candidates: ATHATLRecord[],
  direction: SpreadDirection,
  config: SpreadConfig
): Promise<RankedCandidate[]> {
  const results: RankedCandidate[] = [];
  const OPTION_BATCH_SIZE = 10; // 避免觸發 rate limit

  for (let i = 0; i < candidates.length; i += OPTION_BATCH_SIZE) {
    const batch = candidates.slice(i, i + OPTION_BATCH_SIZE);
    console.log(`[CreditSpread] Processing ${direction} batch ${Math.floor(i / OPTION_BATCH_SIZE) + 1}/${Math.ceil(candidates.length / OPTION_BATCH_SIZE)}`);

    const promises = batch.map(async (stock) => {
      try {
        return await processSingleStock(stock, direction, config);
      } catch (e) {
        console.error(`[CreditSpread] Error processing ${stock.symbol}:`, e);
        return null;
      }
    });

    const batchResults = await Promise.all(promises);
    
    for (const result of batchResults) {
      if (result) {
        results.push(result);
      }
    }

    // 每批之間延遲，避免觸發 Yahoo rate limit
    if (i + OPTION_BATCH_SIZE < candidates.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  return results;
}

/**
 * 處理單一股票
 */
async function processSingleStock(
  stock: ATHATLRecord,
  direction: SpreadDirection,
  config: SpreadConfig
): Promise<RankedCandidate | null> {
  try {
    // 3. 技術面反轉訊號確認
    const reversalSignal = await confirmReversalSignal(stock, direction);
    
    // Bull Put 方向：沒有反轉訊號直接淘汰
    if (direction === "bull_put" && !reversalSignal.confirmed) {
      console.log(`[CreditSpread] ${stock.symbol} (bull_put) 技術面無反轉訊號，被排除`);
      return null;
    }

    // 4. IV Rank 計算
    const ivRank = await calculateIVRank(stock.symbol);

    // 5. 選擇權鏈抓取
    const optionChain = await getOptionChainWithDelta(stock.symbol);
    if (!optionChain) {
      console.log(`[CreditSpread] ${stock.symbol} 無法取得選擇權鏈資料`);
      return null;
    }

    // 6. 履約價選擇
    const candidate = selectSpreadStrikes(optionChain, direction, config, stock.last_close);
    if (!candidate) {
      console.log(`[CreditSpread] ${stock.symbol} 無法找到合適的履約價組合`);
      return null;
    }

    // 填入股票資訊
    candidate.symbol = stock.symbol;
    candidate.companyName = stock.company_name;

    // 7. 評分
    const score = scoreSpreadCandidate(candidate, reversalSignal, ivRank, direction, config);
    if (score === null) {
      return null;
    }

    return {
      ...candidate,
      score,
      reversalSignal,
      ivRank,
      daysToEarnings: stock.days_to_earnings,
    };
  } catch (e) {
    console.error(`[CreditSpread] Error in processSingleStock for ${stock.symbol}:`, e);
    return null;
  }
}

// ============ Cache Management ============

export function getCachedCreditSpreadResults(): { bearCallSpreads: RankedCandidate[]; bullPutSpreads: RankedCandidate[]; lastUpdated: string } | null {
  return cachedResults;
}

export function clearCreditSpreadCache(): void {
  cachedResults = null;
  cachedResultsTime = 0;
  console.log("[CreditSpread] Cache cleared");
}