/**
 * accumulationScore.ts — 建倉評分計算模組
 * 
 * 用於評估股票在創低點後的建倉/築底訊號
 * 只在使用者點擊查看詳情時才計算，不在批量掃描時執行
 * 
 * 七項訊號：nearATL, climaxUpVolume, obvDivergence, mfiStrong, accumulationDays, failedBreakdown, shortSqueezeSetup
 */

import { yahooFinance } from "./stocks";
import axios from "axios";
import { analyzeDivergence, calculateIndicators, findSwingPoints, type Candle, type DivergenceResult, type IndicatorValue, type SwingPoint, type MatchedIndicatorDetail, type InsufficientDataError, type Strength, type DivergenceMode } from "./divergence";
import { fetchFinraShortVolume, type FinraShortVolumeBar } from "./distributionScore";

// ============ Types ============

export interface OHLCVBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AccumulationSignal {
  name: string;
  label: string;
  detail: string;
  points: number;
}

export interface AccumulationScoreResult {
  totalScore: number;
  signals: AccumulationSignal[];
  hasShortVolumeData: boolean;
  error?: string;
}

// ============ Weight Configuration (Fixed 100) ============

const WEIGHTS = {
  nearATL: 12,
  climaxUpVolume: 13,
  obvDivergence: 18,
  mfiStrong: 18,
  accumulationDays: 15,
  failedBreakdown: 12,
  shortSqueezeSetup: 12,
};

// Verify weight sum equals 100
const WEIGHT_SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (WEIGHT_SUM !== 100) {
  console.error(`[AccumulationScore] WARNING: Weight sum is ${WEIGHT_SUM}, expected 100`);
}

// ============ Helper: Convert OHLCVBar[] to Candle[] ============

function barsToCandles(bars: OHLCVBar[]): Candle[] {
  return bars.map((b) => ({
    date: b.date instanceof Date ? b.date.toISOString().slice(0, 19) : String(b.date),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

// ============ IBD Accumulation Day Evaluation ============

export interface AccumulationDayResult {
  count: number;
  offsetCount: number;
  effectiveCount: number;
  score: number;
  detail: string;
}

/**
 * 評估 IBD Accumulation Days (建倉日)
 * - 25日滾動視窗
 * - 漲幅 >= +0.2% 且成交量 > 前日 = Accumulation Day
 * - 跌幅 <= -1.5% 且成交量 > 前日 = Selloff Day (可抵銷)
 */
export function evalIBDAccumulationDays(bars: OHLCVBar[], symbol: string = "UNKNOWN"): AccumulationDayResult {
  const windowBars = bars.slice(-25);
  
  if (windowBars.length < 25) {
    return { count: 0, offsetCount: 0, effectiveCount: 0, score: 0, detail: "資料不足25個交易日，無法計算" };
  }

  interface DayFlag {
    index: number;
    isAccumulation: boolean;
    isSelloff: boolean;
    close: number;
    offset: boolean;
  }

  const flags: DayFlag[] = windowBars.map((bar, i) => {
    if (i === 0) {
      return { index: i, isAccumulation: false, isSelloff: false, close: bar.close, offset: false };
    }

    const prevClose = windowBars[i - 1].close;
    const prevVolume = windowBars[i - 1].volume;
    const changePct = ((bar.close - prevClose) / prevClose) * 100;

    const isAccumulation = changePct >= 0.2 && bar.volume > prevVolume;
    const isSelloff = changePct <= -1.5 && bar.volume > prevVolume;

    return { index: i, isAccumulation, isSelloff, close: bar.close, offset: false };
  });

  const rawCount = flags.filter((f) => f.isAccumulation).length;

  // 抵銷規則一：強力賣壓日抵銷最舊的建倉日
  for (const f of flags) {
    if (f.isSelloff) {
      const oldestUnoffset = flags.find((d) => d.isAccumulation && !d.offset);
      if (oldestUnoffset) {
        oldestUnoffset.offset = true;
      }
    }
  }

  // 抵銷規則二：兩個建倉日相隔3日內且後者收盤價低於前者
  const accumulationFlags = flags.filter((f) => f.isAccumulation);
  for (let i = 0; i < accumulationFlags.length - 1; i++) {
    const curr = accumulationFlags[i];
    const next = accumulationFlags[i + 1];
    if (!curr.offset && next.index - curr.index <= 3 && next.close < curr.close) {
      curr.offset = true;
    }
  }

  const offsetCount = flags.filter((f) => f.isAccumulation && f.offset).length;
  const effectiveCount = rawCount - offsetCount;

  let score = 0;
  let confidenceLabel = "低信心";

  if (effectiveCount >= 6) {
    score = 1;
    confidenceLabel = "高信心";
  } else if (effectiveCount >= 4) {
    score = 0.7;
    confidenceLabel = "中高信心";
  } else if (effectiveCount >= 2) {
    score = 0.4;
    confidenceLabel = "中信心";
  }

  console.log(`[AccScore:accumulationDays] ${symbol} -`, { rawCount, offsetCount, effectiveCount, score });

  return { count: rawCount, offsetCount, effectiveCount, score, detail: `25日內${rawCount}個建倉日，抵銷${offsetCount}個，有效${effectiveCount}個，屬${confidenceLabel}` };
}

// ============ Signal Evaluation Functions ============

/**
 * 還原特定指標實際用來比較的兩個點
 * 依divergence_type決定用confirmedHighs（bearish）還是confirmedLows（bullish）
 */
function getIndicatorSwingComparison(
  bars: OHLCVBar[],
  divergenceResult: DivergenceResult | null,
  indicatorKey: "obv" | "mfi",
  mode: DivergenceMode
): {
  date1: string;
  date2: string;
  priceAtSwing1: number;
  priceAtSwing2: number;
  indicatorValue1: number;
  indicatorValue2: number;
} | null {
  if (!divergenceResult || !divergenceResult.swing_points || !divergenceResult.indicator_values) {
    return null;
  }

  const isBearish = divergenceResult.divergence_type === "bearish";
  const swingType = isBearish ? "high" : "low";
  const confirmedPoints = divergenceResult.swing_points.filter((p) => p.type === swingType);

  if (confirmedPoints.length < 1) return null;

  if (mode === "confirmed") {
    if (confirmedPoints.length < 2) return null;
    const p1 = confirmedPoints[confirmedPoints.length - 2];
    const p2 = confirmedPoints[confirmedPoints.length - 1];
    return {
      date1: p1.date,
      date2: p2.date,
      priceAtSwing1: p1.price,
      priceAtSwing2: p2.price,
      indicatorValue1: divergenceResult.indicator_values[p1.index]?.[indicatorKey] as number,
      indicatorValue2: divergenceResult.indicator_values[p2.index]?.[indicatorKey] as number,
    };
  } else {
    const prevPoint = confirmedPoints[confirmedPoints.length - 1];
    const latestIdx = divergenceResult.indicator_values.length - 1;
    const latestBar = bars[bars.length - 1];
    return {
      date1: prevPoint.date,
      date2: divergenceResult.indicator_values[latestIdx]?.date ?? latestBar.date.toString(),
      priceAtSwing1: prevPoint.price,
      priceAtSwing2: isBearish ? latestBar.high : latestBar.low,
      indicatorValue1: divergenceResult.indicator_values[prevPoint.index]?.[indicatorKey] as number,
      indicatorValue2: divergenceResult.indicator_values[latestIdx]?.[indicatorKey] as number,
    };
  }
}

function isInsufficientData(result: DivergenceResult | InsufficientDataError): result is InsufficientDataError {
  return "status" in result;
}

function getDivergenceAnalysis(bars: OHLCVBar[], symbol: string, companyName: string, exchange: string): DivergenceResult | null {
  const candles = barsToCandles(bars);
  const result = analyzeDivergence(symbol, companyName, exchange, "1d", candles);
  if (isInsufficientData(result)) return null;
  return result;
}

/**
 * Signal 1: nearATL
 */
function evalNearATL(bars: OHLCVBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  const recent20 = bars.slice(-20);
  const periodLow = Math.min(...recent20.map(b => b.low));
  const lastClose = bars[bars.length - 1].close;
  const distancePct = ((lastClose - periodLow) / periodLow) * 100;

  console.log(`[AccScore:nearATL] ${symbol} -`, { periodLow: periodLow.toFixed(2), lastClose: lastClose.toFixed(2), distancePct: distancePct.toFixed(2) });

  if (distancePct <= 2) return { detected: true, points: WEIGHTS.nearATL, detail: `距${periodLow.toFixed(2)}低點低於2%` };
  if (distancePct <= 5) return { detected: true, points: WEIGHTS.nearATL * 0.6, detail: `距${periodLow.toFixed(2)}低點低於5%` };
  return { detected: false, points: 0, detail: `距低點${distancePct.toFixed(1)}%` };
}

/**
 * Signal 2: climaxUpVolume
 */
function evalClimaxUpVolume(bars: OHLCVBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  const recent5 = bars.slice(-5);
  const avgVolume = bars.slice(-20, -5).reduce((sum, b) => sum + b.volume, 0) / 15;

  const dailyDetails = recent5.map((bar) => {
    const changePct = ((bar.close - bar.open) / bar.open) * 100;
    const volumeRatio = bar.volume / avgVolume;
    return { changePct: changePct.toFixed(2), volumeRatio: volumeRatio.toFixed(2) };
  });

  console.log(`[AccScore:climaxUpVolume] ${symbol} -`, { avgVolume20: avgVolume.toFixed(0), recent5Days: dailyDetails });

  let maxClimax = 0;
  let climaxDetail = "";
  
  for (const bar of recent5) {
    const changePct = ((bar.close - bar.open) / bar.open) * 100;
    const volumeRatio = bar.volume / avgVolume;
    if (changePct >= 3 && volumeRatio > 2) {
      const score = Math.min(WEIGHTS.climaxUpVolume, WEIGHTS.climaxUpVolume * volumeRatio / 3);
      if (score > maxClimax) {
        maxClimax = score;
        climaxDetail = `單日漲${changePct.toFixed(1)}%且量能${volumeRatio.toFixed(1)}x`;
      }
    }
  }
  
  if (maxClimax > 0) return { detected: true, points: maxClimax, detail: climaxDetail };
  return { detected: false, points: 0, detail: "無明顯爆量反彈" };
}

/**
 * Signal 3: obvDivergence - 多頭背離
 */
function evalOBVDivergence(
  bars: OHLCVBar[],
  divergenceResult: DivergenceResult | null,
  symbol: string
): { detected: boolean; points: number; detail: string } {
  const obvMatched = divergenceResult?.matched_details.find((d) => d.indicator === "OBV") ?? null;
  const obvComparison = obvMatched ? getIndicatorSwingComparison(bars, divergenceResult, "obv", obvMatched.mode) : null;

  console.log(`[AccScore:obvDivergence] ${symbol} -`, {
    hasDivergenceResult: !!divergenceResult,
    divergence_type: divergenceResult?.divergence_type ?? "N/A",
    strength: divergenceResult?.strength ?? "N/A",
    matchedIndicators: divergenceResult?.matched_indicators ?? [],
    obvMatchedDetail: obvMatched,
    obvSwingComparison: obvComparison ? {
      mode: obvMatched?.mode,
      date1: obvComparison.date1,
      date2: obvComparison.date2,
      priceAtSwing1: obvComparison.priceAtSwing1.toFixed(2),
      priceAtSwing2: obvComparison.priceAtSwing2.toFixed(2),
      obvValue1: obvComparison.indicatorValue1,
      obvValue2: obvComparison.indicatorValue2,
    } : "N/A",
  });

  if (!divergenceResult) return { detected: false, points: 0, detail: "資料不足，無法判斷背離" };
  if (divergenceResult.divergence_type !== "bullish") return { detected: false, points: 0, detail: "目前無多頭背離訊號" };
  if (!obvMatched) return { detected: false, points: 0, detail: "OBV未出現背離" };

  const liveTag = obvMatched.mode === "live" ? "（即時形成中）" : "（已確認）";
  const strengthMap: Record<string, number> = { weak: 0.4, moderate: 0.6, strong: 0.8, very_strong: 1 };
  const strengthFactor = strengthMap[divergenceResult.strength] ?? 0.5;

  return {
    detected: true,
    points: WEIGHTS.obvDivergence * strengthFactor,
    detail: `OBV出現多頭背離${liveTag}，整體強度：${divergenceResult.strength}`,
  };
}

/**
 * Signal 4: mfiStrong - MFI 回升
 */
function evalMFIStrong(
  bars: OHLCVBar[],
  divergenceResult: DivergenceResult | null,
  symbol: string
): { detected: boolean; points: number; detail: string } {
  const mfiMatched = divergenceResult?.matched_details.find((d) => d.indicator === "MFI") ?? null;
  const candles = barsToCandles(bars);
  const indicators = calculateIndicators(candles);
  const recentMFI = indicators.slice(-10).map((d) => d.mfi);
  const currentMFI = recentMFI[recentMFI.length - 1];
  const avgMFI = recentMFI.length > 1 ? recentMFI.slice(0, -1).reduce((a, b) => a + b, 0) / (recentMFI.length - 1) : null;

  const mfiComparison = mfiMatched ? getIndicatorSwingComparison(bars, divergenceResult, "mfi", mfiMatched.mode) : null;

  console.log(`[AccScore:mfiStrong] ${symbol} -`, {
    hasDivergenceResult: !!divergenceResult,
    divergence_type: divergenceResult?.divergence_type ?? "N/A",
    mfiMatchedDetail: mfiMatched,
    currentMFI: currentMFI?.toFixed(2) ?? "N/A",
    avgMFI: avgMFI?.toFixed(2) ?? "N/A",
    mfiSwingComparison: mfiComparison ? {
      mode: mfiMatched?.mode,
      date1: mfiComparison.date1,
      date2: mfiComparison.date2,
      priceAtSwing1: mfiComparison.priceAtSwing1.toFixed(2),
      priceAtSwing2: mfiComparison.priceAtSwing2.toFixed(2),
      mfiValue1: mfiComparison.indicatorValue1,
      mfiValue2: mfiComparison.indicatorValue2,
    } : "N/A",
  });

  // 第一層：從analyzeDivergence()結果檢查MFI多頭背離
  if (divergenceResult && divergenceResult.divergence_type === "bullish" && mfiMatched) {
    const liveTag = mfiMatched.mode === "live" ? "（即時形成中）" : "（已確認）";
    const strengthMap: Record<string, number> = { weak: 0.4, moderate: 0.6, strong: 0.8, very_strong: 1 };
    const strengthFactor = strengthMap[divergenceResult.strength] ?? 0.5;
    return { detected: true, points: WEIGHTS.mfiStrong * strengthFactor, detail: `MFI出現多頭背離${liveTag}，整體強度：${divergenceResult.strength}` };
  }

  // 第二層：沒有背離型態時，退回檢查MFI水位
  if (recentMFI.length < 5) return { detected: false, points: 0, detail: "資料不足" };

  if (currentMFI > 30 && currentMFI > avgMFI! * 1.2) {
    return { detected: true, points: WEIGHTS.mfiStrong * 0.5, detail: `MFI=${currentMFI.toFixed(0)}回升至30以上且高於均值（無明確背離型態）` };
  }
  if (currentMFI > 50) {
    return { detected: true, points: WEIGHTS.mfiStrong * 0.25, detail: `MFI=${currentMFI.toFixed(0)}回到50以上（無明確背離型態）` };
  }

  return { detected: false, points: 0, detail: `MFI=${currentMFI.toFixed(0)}仍低` };
}

/**
 * Signal 5: accumulationDays
 */
function evalAccumulationDays(bars: OHLCVBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  const result = evalIBDAccumulationDays(bars, symbol);
  if (result.effectiveCount >= 6) return { detected: true, points: WEIGHTS.accumulationDays, detail: result.detail };
  if (result.effectiveCount >= 4) return { detected: true, points: WEIGHTS.accumulationDays * 0.7, detail: result.detail };
  if (result.effectiveCount >= 2) return { detected: true, points: WEIGHTS.accumulationDays * 0.4, detail: result.detail };
  return { detected: false, points: 0, detail: result.detail };
}

/**
 * Signal 6: failedBreakdown
 */
function evalFailedBreakdown(bars: OHLCVBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  if (bars.length < 30) return { detected: false, points: 0, detail: "資料不足" };

  const recent30 = bars.slice(-30);
  const periodLow = Math.min(...recent30.map(b => b.low));
  const lowIndex = recent30.findIndex(b => b.low === periodLow);

  console.log(`[AccScore:failedBreakdown] ${symbol} -`, { periodLow: periodLow.toFixed(2), lowIndex, daysSinceLow: recent30.length - 1 - lowIndex });

  if (lowIndex < recent30.length - 5) {
    const afterLow = recent30.slice(lowIndex);
    const failed = afterLow.some(b => b.close > periodLow * 1.03);
    if (failed) return { detected: true, points: WEIGHTS.failedBreakdown, detail: `跌破${periodLow.toFixed(2)}後反彈超過3%` };
  }

  return { detected: false, points: 0, detail: "無假破底訊號" };
}

/**
 * Signal 7: shortSqueezeSetup
 */
function evalShortSqueezeSetup(finraData: FinraShortVolumeBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  if (!finraData || finraData.length === 0) return { detected: false, points: 0, detail: "無FINRA資料" };

  const recentData = finraData.slice(-10);
  const avgRatio = recentData.reduce((sum, d) => sum + d.shortRatio, 0) / recentData.length;

  console.log(`[AccScore:shortSqueezeSetup] ${symbol} -`, { recordCount: finraData.length, recentDataUsed: recentData.length, avgRatioPct: (avgRatio * 100).toFixed(2) });

  if (avgRatio > 0.4) return { detected: true, points: WEIGHTS.shortSqueezeSetup * 0.5, detail: `放空量平均佔${(avgRatio * 100).toFixed(1)}%，逼空潛力高` };
  if (avgRatio > 0.3) return { detected: true, points: WEIGHTS.shortSqueezeSetup * 0.3, detail: `放空量平均佔${(avgRatio * 100).toFixed(1)}%，具備一定逼空潛力` };
  return { detected: false, points: 0, detail: `放空量佔比${(avgRatio * 100).toFixed(1)}%，逼空潛力不明顯` };
}

// ============ Main Score Computation ============

export interface AccumulationScoreMeta {
  symbol: string;
  companyName: string;
  exchange: string;
}

export function computeAccumulationScore(
  bars: OHLCVBar[],
  finraData?: FinraShortVolumeBar[],
  meta?: AccumulationScoreMeta
): AccumulationScoreResult {
  const signals: AccumulationSignal[] = [];
  let totalPoints = 0;
  const symbol = meta?.symbol ?? "UNKNOWN";

  function safeEval<T extends { detected: boolean; points: number; detail: string }>(
    signalName: string, fn: () => T
  ): T {
    try { return fn(); }
    catch (e: any) {
      console.error(`[AccScore:${signalName}] ${symbol} - EXCEPTION`, { message: e?.message ?? "unknown error" });
      return { detected: false, points: 0, detail: `計算失敗: ${e?.message ?? "unknown error"}` } as T;
    }
  }

  let divergenceResult: ReturnType<typeof getDivergenceAnalysis> = null;
  if (meta) {
    try { divergenceResult = getDivergenceAnalysis(bars, meta.symbol, meta.companyName, meta.exchange); }
    catch (e: any) { console.error(`[AccScore:divergenceAnalysis] ${symbol} - EXCEPTION`, { message: e?.message ?? "unknown error" }); }
  }

  const nearATL = safeEval("nearATL", () => evalNearATL(bars, symbol));
  if (nearATL.detected) { signals.push({ name: "nearATL", label: "接近低點", detail: nearATL.detail, points: nearATL.points }); totalPoints += nearATL.points; }

  const climaxUpVolume = safeEval("climaxUpVolume", () => evalClimaxUpVolume(bars, symbol));
  if (climaxUpVolume.detected) { signals.push({ name: "climaxUpVolume", label: "爆量反彈", detail: climaxUpVolume.detail, points: climaxUpVolume.points }); totalPoints += climaxUpVolume.points; }

  const obvDivergence = safeEval("obvDivergence", () => evalOBVDivergence(bars, divergenceResult, symbol));
  if (obvDivergence.detected) { signals.push({ name: "obvDivergence", label: "OBV背離", detail: obvDivergence.detail, points: obvDivergence.points }); totalPoints += obvDivergence.points; }

  const mfiStrong = safeEval("mfiStrong", () => evalMFIStrong(bars, divergenceResult, symbol));
  if (mfiStrong.detected) { signals.push({ name: "mfiStrong", label: "MFI回升", detail: mfiStrong.detail, points: mfiStrong.points }); totalPoints += mfiStrong.points; }

  const accumulationDaysResult = safeEval("accumulationDays", () => evalAccumulationDays(bars, symbol));
  if (accumulationDaysResult.detected) { signals.push({ name: "accumulationDays", label: "建倉日", detail: accumulationDaysResult.detail, points: accumulationDaysResult.points }); totalPoints += accumulationDaysResult.points; }

  const failedBreakdown = safeEval("failedBreakdown", () => evalFailedBreakdown(bars, symbol));
  if (failedBreakdown.detected) { signals.push({ name: "failedBreakdown", label: "假破底", detail: failedBreakdown.detail, points: failedBreakdown.points }); totalPoints += failedBreakdown.points; }

  const hasFinraData = !!finraData && finraData.length > 0;
  const shortSqueezeSetup = safeEval("shortSqueezeSetup", () => evalShortSqueezeSetup(finraData, symbol));
  if (shortSqueezeSetup.detected) { signals.push({ name: "shortSqueezeSetup", label: "逼空潛力", detail: shortSqueezeSetup.detail, points: shortSqueezeSetup.points }); totalPoints += shortSqueezeSetup.points; }
  else if (!hasFinraData) { signals.push({ name: "shortSqueezeSetup", label: "逼空潛力", detail: "無FINRA資料", points: 0 }); }

  return { totalScore: Math.min(100, totalPoints), signals, hasShortVolumeData: hasFinraData };
}

async function fetchChartWithRetry(ticker: string, period1: Date, period2: Date): Promise<any> {
  const attemptFetch = () => yahooFinance.chart(ticker, { period1, period2, interval: "1d" });
  try { return await attemptFetch(); }
  catch (firstError: any) {
    console.error(`[AccumulationScore] Yahoo Finance first attempt failed for ${ticker}:`, { message: firstError?.message });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try { return await attemptFetch(); }
    catch (secondError: any) {
      console.error(`[AccumulationScore] Yahoo Finance retry also failed for ${ticker}:`, { message: secondError?.message });
      throw secondError;
    }
  }
}

export async function computeAccumulationScoreForTicker(ticker: string): Promise<AccumulationScoreResult> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 120);

    let chart;
    try { chart = await fetchChartWithRetry(ticker, startDate, endDate); }
    catch (chartError: any) {
      return { totalScore: 0, signals: [], hasShortVolumeData: false, error: `無法取得${ticker}的歷史股價資料，Yahoo Finance連線逾時，請稍後再試` };
    }

    const rawQuotes = chart?.quotes ?? [];
    const validQuotes = rawQuotes.filter((q: any) =>
      q.close !== null && q.close !== undefined &&
      q.open !== null && q.open !== undefined &&
      q.high !== null && q.high !== undefined &&
      q.low !== null && q.low !== undefined
    );

    const droppedCount = rawQuotes.length - validQuotes.length;
    if (droppedCount > 0) {
      console.log(`[AccumulationScore] Dropped ${droppedCount} incomplete bar(s) for ${ticker}`);
    }

    const bars: OHLCVBar[] = validQuotes.map((q: any) => ({
      date: q.date,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume ?? 0,
    }));

    if (bars.length < 50) {
      return { totalScore: 0, signals: [], hasShortVolumeData: false, error: `資料不足(僅${bars.length}個交易日)，無法計算建倉評分` };
    }

    let finraData: FinraShortVolumeBar[] | undefined;
    try { finraData = await fetchFinraShortVolume(ticker, 25); }
    catch (e) { console.error(`[AccumulationScore] FINRA data fetch failed for ${ticker}:`, e); }

    const result = computeAccumulationScore(bars, finraData, { symbol: ticker, companyName: ticker, exchange: "NASDAQ" });
    return result;
  } catch (e: any) {
    console.error(`[AccumulationScore] Error computing score for ${ticker}:`, e);
    return { totalScore: 0, signals: [], hasShortVolumeData: false, error: `計算建倉評分時發生錯誤: ${e.message}` };
  }
}