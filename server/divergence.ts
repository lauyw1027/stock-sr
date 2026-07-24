/**
 * divergence.ts — 技術指標計算與背離判斷核心引擎（完整修正版 v4）
 *
 * 修正歷程：
 * v1: MACD Signal Line 連續EMA / 標準EMA乘數 / RSI Wilder's Smoothing / Swing用high-low
 * v2: Live Divergence — 最新K棒 vs 最近已確認swing，解決剛創新高抓不到背離的問題
 * v3: Slope Divergence（總漲幅比較）— 但此法對OBV等累積型指標不準確，v4已取代
 * v4: 修正 —
 *   1. OBV/MFI 改用「動能趨緩比較」(checkMomentumSlowdown)：
 *      比較「最近N天」與「前一段N天」的變化率，抓橫盤走平，不用總漲幅百分比（該法對OBV不準）
 *   2. MACD live比較改用「平滑窗口」(checkLiveDivergenceSmoothed)：
 *      取最近3天histogram平均值，避免單日噪音造成漏判
 */

import YahooFinance from "yahoo-finance2";

// yahoo-finance2 v3+ requires instantiation with new
const yahooFinance = new YahooFinance();

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "30m" | "60m" | "1d" | "1wk";
export type DivergenceType = "bullish" | "bearish";
export type Strength = "weak" | "moderate" | "strong" | "very_strong";
export type DivergenceMode = "confirmed" | "live";

export interface SwingPoint {
  type: "high" | "low";
  index: number;
  price: number;
  date: string;
}

export interface IndicatorValue {
  date: string;
  price: number;
  volume: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  rsi: number;
  obv: number;
  mfi: number;
}

export interface MatchedIndicatorDetail {
  indicator: string;
  pattern: "peak" | "momentum" | "volume";
  mode: DivergenceMode;
}

export interface DivergenceResult {
  symbol: string;
  company_name: string;
  exchange: string;
  timeframe: Timeframe;
  divergence_type: DivergenceType;
  strength: Strength;
  matched_indicators: string[];
  matched_details: MatchedIndicatorDetail[];
  matched_count: number;
  is_live: boolean;
  last_close: number;
  swing_price_1: number;
  swing_price_2: number;
  swing_date_1: string;
  swing_date_2: string;
  updated_at: string;
  swing_points: SwingPoint[];
  indicator_values: IndicatorValue[];
}

export interface ScanResult {
  symbol: string;
  company_name: string;
  exchange: string;
  timeframe: Timeframe;
  divergence_type: DivergenceType;
  strength: Strength;
  matched_indicators: string[];
  matched_count: number;
  is_live: boolean;
  last_close: number;
  swing_price_1: number;
  swing_price_2: number;
  swing_date_1: string;
  swing_date_2: string;
  updated_at: string;
}

export interface InsufficientDataError {
  status: "insufficient_data" | "no_divergence";
  message: string;
  symbol: string;
  timeframe: Timeframe;
  bars_available: number;
  bars_required: number;
}

function round(v: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function emaSeries(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return result;

  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

export function calculateIndicators(candles: Candle[]): IndicatorValue[] {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const n = candles.length;

  const rsi: number[] = new Array(n).fill(50);
  {
    const gains: number[] = [0];
    const losses: number[] = [0];
    for (let i = 1; i < n; i++) {
      const change = closes[i] - closes[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
    }

    const period = 14;
    if (n > period) {
      let avgGain = gains.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
      let avgLoss = losses.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;

      rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

      for (let i = period + 1; i < n; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
  }

  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(ema12[i]) && !isNaN(ema26[i])) {
      macdLine[i] = ema12[i] - ema26[i];
    }
  }

  const macdValidStartIdx = macdLine.findIndex(v => !isNaN(v));
  const macdValidSeries = macdLine.slice(macdValidStartIdx).map(v => v as number);
  const signalValidSeries = emaSeries(macdValidSeries, 9);

  const signalLine: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < signalValidSeries.length; i++) {
    signalLine[macdValidStartIdx + i] = signalValidSeries[i];
  }

  const histogram: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(macdLine[i]) && !isNaN(signalLine[i])) {
      histogram[i] = macdLine[i] - signalLine[i];
    }
  }

  const obv: number[] = new Array(n).fill(0);
  obv[0] = volumes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - volumes[i];
    else obv[i] = obv[i - 1];
  }

  const mfi: number[] = new Array(n).fill(50);
  {
    const typicalPrices = candles.map(c => (c.high + c.low + c.close) / 3);
    const rawMoneyFlow = typicalPrices.map((tp, i) => tp * volumes[i]);
    const period = 14;

    for (let i = period; i < n; i++) {
      let positiveFlow = 0;
      let negativeFlow = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (j === 0) continue;
        if (typicalPrices[j] > typicalPrices[j - 1]) positiveFlow += rawMoneyFlow[j];
        else if (typicalPrices[j] < typicalPrices[j - 1]) negativeFlow += rawMoneyFlow[j];
      }
      if (negativeFlow === 0) {
        mfi[i] = 100;
      } else {
        const moneyFlowRatio = positiveFlow / negativeFlow;
        mfi[i] = 100 - 100 / (1 + moneyFlowRatio);
      }
    }
  }

  const result: IndicatorValue[] = [];
  for (let i = 0; i < n; i++) {
    result.push({
      date: candles[i].date,
      price: candles[i].close,
      volume: candles[i].volume,
      macd: isNaN(macdLine[i]) ? 0 : round(macdLine[i], 4),
      macdSignal: isNaN(signalLine[i]) ? 0 : round(signalLine[i], 4),
      macdHistogram: isNaN(histogram[i]) ? 0 : round(histogram[i], 4),
      rsi: round(rsi[i], 2),
      obv: obv[i],
      mfi: round(mfi[i], 2),
    });
  }
  return result;
}

export function findSwingPoints(candles: Candle[], k: number): SwingPoint[] {
  const points: SwingPoint[] = [];

  for (let i = k; i < candles.length - k; i++) {
    const left = candles.slice(i - k, i);
    const right = candles.slice(i + 1, i + k + 1);
    const current = candles[i];

    const leftHighs = left.map(c => c.high);
    const rightHighs = right.map(c => c.high);
    const isHigh =
      current.high >= Math.max(...leftHighs) &&
      current.high >= Math.max(...rightHighs);

    const leftLows = left.map(c => c.low);
    const rightLows = right.map(c => c.low);
    const isLow =
      current.low <= Math.min(...leftLows) &&
      current.low <= Math.min(...rightLows);

    if (isHigh) points.push({ type: "high", index: i, price: current.high, date: current.date });
    if (isLow) points.push({ type: "low", index: i, price: current.low, date: current.date });
  }

  return points;
}

function checkPeakDivergence(
  swingPairs: { price: number; value: number }[],
  isBearish: boolean
): boolean {
  if (swingPairs.length < 2) return false;
  const p1 = swingPairs[swingPairs.length - 2];
  const p2 = swingPairs[swingPairs.length - 1];

  if (isBearish) {
    return p2.price > p1.price && p2.value < p1.value;
  } else {
    return p2.price < p1.price && p2.value > p1.value;
  }
}

/**
 * 動能趨緩背離（取代v3的百分比slope法）：
 * 比較「最近recentWindow天」的指標變化量 vs「前一段priorWindow天」的變化量。
 * 用來抓OBV/MFI這類累積型或有界型指標「仍在漲但漲勢明顯減速（走平）」的情況，
 * 不受「總漲幅百分比」誤導（OBV總漲幅可能仍大於價格總漲幅，但近期已經走平）。
 */
function checkMomentumSlowdown(
  indicators: IndicatorValue[],
  indicatorKey: keyof IndicatorValue,
  isBearish: boolean,
  recentWindow = 5,
  priorWindow = 5
): boolean {
  const n = indicators.length;
  if (n < recentWindow + priorWindow + 1) return false;

  const recentStart = n - recentWindow;
  const priorStart = n - recentWindow - priorWindow;

  const recentValues = indicators.slice(recentStart).map(d => d[indicatorKey] as number);
  const priorValues = indicators.slice(priorStart, recentStart).map(d => d[indicatorKey] as number);

  const recentChange = recentValues[recentValues.length - 1] - recentValues[0];
  const priorChange = priorValues[priorValues.length - 1] - priorValues[0];

  const priceRecent = indicators.slice(recentStart).map(d => d.price);
  const priceRecentChange = priceRecent[priceRecent.length - 1] - priceRecent[0];

  if (isBearish) {
    const priceStillRising = priceRecentChange > 0;
    const momentumSlowing = priorChange > 0 && recentChange < priorChange * 0.3;
    return priceStillRising && momentumSlowing;
  } else {
    const priceStillFalling = priceRecentChange < 0;
    const momentumSlowing = priorChange < 0 && recentChange > priorChange * 0.3;
    return priceStillFalling && momentumSlowing;
  }
}

function checkVolumeDivergence(
  candles: Candle[],
  swingPoints: SwingPoint[],
  isBearish: boolean
): boolean {
  const filtered = swingPoints.filter(p => p.type === (isBearish ? "high" : "low"));
  if (filtered.length < 2) return false;

  const p1 = filtered[filtered.length - 2];
  const p2 = filtered[filtered.length - 1];

  const volume1 = candles[p1.index].volume;
  const volume2 = candles[p2.index].volume;
  const volumeDeclined = volume2 < volume1;

  if (isBearish) {
    return p2.price > p1.price && volumeDeclined;
  } else {
    return p2.price < p1.price && volumeDeclined;
  }
}

/**
 * Live 背離（一般型）：最新K棒 vs 最近一個已確認swing point，不用右側k天驗證。
 */
function checkLiveDivergence(
  candles: Candle[],
  indicators: IndicatorValue[],
  confirmedPoints: SwingPoint[],
  indicatorKey: keyof IndicatorValue,
  isBearish: boolean
): boolean {
  if (confirmedPoints.length < 1) return false;

  const lastIdx = candles.length - 1;
  const latestPrice = isBearish ? candles[lastIdx].high : candles[lastIdx].low;
  const latestIndicatorValue = indicators[lastIdx][indicatorKey] as number;

  const prevPoint = confirmedPoints[confirmedPoints.length - 1];
  const prevIndicatorValue = indicators[prevPoint.index][indicatorKey] as number;

  if (isBearish) {
    return latestPrice > prevPoint.price && latestIndicatorValue < prevIndicatorValue;
  } else {
    return latestPrice < prevPoint.price && latestIndicatorValue > prevIndicatorValue;
  }
}

/**
 * Live 背離（平滑版，用於MACD）：
 * 用最近smoothWindow天的histogram平均值，取代單一最新K棒的值，
 * 避免單日噪音造成MACD明明已死叉卻因單日反彈而漏判。
 */
function checkLiveDivergenceSmoothed(
  candles: Candle[],
  indicators: IndicatorValue[],
  confirmedPoints: SwingPoint[],
  indicatorKey: keyof IndicatorValue,
  isBearish: boolean,
  smoothWindow = 3
): boolean {
  if (confirmedPoints.length < 1) return false;

  const n = candles.length;
  const latestPrice = isBearish ? candles[n - 1].high : candles[n - 1].low;

  const recentSlice = indicators.slice(Math.max(0, n - smoothWindow));
  const latestIndicatorAvg =
    recentSlice.reduce((sum, d) => sum + (d[indicatorKey] as number), 0) / recentSlice.length;

  const prevPoint = confirmedPoints[confirmedPoints.length - 1];
  const prevIndicatorValue = indicators[prevPoint.index][indicatorKey] as number;

  if (isBearish) {
    return latestPrice > prevPoint.price && latestIndicatorAvg < prevIndicatorValue;
  } else {
    return latestPrice < prevPoint.price && latestIndicatorAvg > prevIndicatorValue;
  }
}

export function analyzeDivergence(
  symbol: string,
  companyName: string,
  exchange: string,
  timeframe: Timeframe,
  candles: Candle[]
): DivergenceResult | InsufficientDataError {
  const minBars = timeframe === "30m" ? 60 : timeframe === "60m" ? 100 : 50;
  const k = timeframe === "30m" || timeframe === "60m" ? 8 : 5;

  if (candles.length < minBars) {
    return {
      status: "insufficient_data",
      message: `資料不足，僅有 ${candles.length} 根K線，需要至少 ${minBars} 根才能形成有效背離判斷`,
      symbol, timeframe, bars_available: candles.length, bars_required: minBars,
    };
  }

  const indicators = calculateIndicators(candles);
  const confirmedSwings = findSwingPoints(candles, k);

  const confirmedHighs = confirmedSwings.filter(p => p.type === "high");
  const confirmedLows = confirmedSwings.filter(p => p.type === "low");

  if (confirmedHighs.length < 1 || confirmedLows.length < 1) {
    return {
      status: "insufficient_data",
      message: `偵測到的擺動點不足，無法形成有效背離判斷（高點：${confirmedHighs.length}，低點：${confirmedLows.length}）`,
      symbol, timeframe, bars_available: candles.length, bars_required: minBars,
    };
  }

  const lastClose = candles[candles.length - 1].close;
  const buildPairs = (points: SwingPoint[], key: keyof IndicatorValue) =>
    points.map(p => ({ price: p.price, value: indicators[p.index][key] as number }));

  const bearishDetails: MatchedIndicatorDetail[] = [];
  const bullishDetails: MatchedIndicatorDetail[] = [];

  if (confirmedHighs.length >= 2) {
    if (checkPeakDivergence(buildPairs(confirmedHighs, "macdHistogram"), true))
      bearishDetails.push({ indicator: "MACD", pattern: "peak", mode: "confirmed" });
    if (checkPeakDivergence(buildPairs(confirmedHighs, "rsi"), true))
      bearishDetails.push({ indicator: "RSI", pattern: "peak", mode: "confirmed" });
    if (checkPeakDivergence(buildPairs(confirmedHighs, "obv"), true))
      bearishDetails.push({ indicator: "OBV", pattern: "peak", mode: "confirmed" });
    if (checkPeakDivergence(buildPairs(confirmedHighs, "mfi"), true))
      bearishDetails.push({ indicator: "MFI", pattern: "peak", mode: "confirmed" });
    if (checkVolumeDivergence(candles, confirmedSwings, true))
      bearishDetails.push({ indicator: "Volume", pattern: "volume", mode: "confirmed" });
  }

  if (confirmedLows.length >= 2) {
    if (checkPeakDivergence(buildPairs(confirmedLows, "macdHistogram"), false))
      bullishDetails.push({ indicator: "MACD", pattern: "peak", mode: "confirmed" });
    if (checkPeakDivergence(buildPairs(confirmedLows, "rsi"), false))
      bullishDetails.push({ indicator: "RSI", pattern: "peak", mode: "confirmed" });
    if (checkPeakDivergence(buildPairs(confirmedLows, "obv"), false))
      bullishDetails.push({ indicator: "OBV", pattern: "peak", mode: "confirmed" });
    if (checkPeakDivergence(buildPairs(confirmedLows, "mfi"), false))
      bullishDetails.push({ indicator: "MFI", pattern: "peak", mode: "confirmed" });
    if (checkVolumeDivergence(candles, confirmedSwings, false))
      bullishDetails.push({ indicator: "Volume", pattern: "volume", mode: "confirmed" });
  }

  if (checkMomentumSlowdown(indicators, "obv", true))
    bearishDetails.push({ indicator: "OBV", pattern: "momentum", mode: "live" });
  if (checkMomentumSlowdown(indicators, "mfi", true))
    bearishDetails.push({ indicator: "MFI", pattern: "momentum", mode: "live" });
  if (checkMomentumSlowdown(indicators, "obv", false))
    bullishDetails.push({ indicator: "OBV", pattern: "momentum", mode: "live" });
  if (checkMomentumSlowdown(indicators, "mfi", false))
    bullishDetails.push({ indicator: "MFI", pattern: "momentum", mode: "live" });

  const latestIdx = candles.length - 1;
  const latestIsBeyondLastConfirmedHigh =
    confirmedHighs.length > 0 && candles[latestIdx].high > confirmedHighs[confirmedHighs.length - 1].price;
  const latestIsBeyondLastConfirmedLow =
    confirmedLows.length > 0 && candles[latestIdx].low < confirmedLows[confirmedLows.length - 1].price;

  if (latestIsBeyondLastConfirmedHigh) {
    if (checkLiveDivergenceSmoothed(candles, indicators, confirmedHighs, "macdHistogram", true))
      bearishDetails.push({ indicator: "MACD", pattern: "peak", mode: "live" });
    if (checkLiveDivergence(candles, indicators, confirmedHighs, "rsi", true))
      bearishDetails.push({ indicator: "RSI", pattern: "peak", mode: "live" });
    if (checkLiveDivergence(candles, indicators, confirmedHighs, "obv", true))
      bearishDetails.push({ indicator: "OBV", pattern: "peak", mode: "live" });
    if (checkLiveDivergence(candles, indicators, confirmedHighs, "mfi", true))
      bearishDetails.push({ indicator: "MFI", pattern: "peak", mode: "live" });

    const prevHigh = confirmedHighs[confirmedHighs.length - 1];
    const latestVolume = candles[latestIdx].volume;
    const prevVolume = candles[prevHigh.index].volume;
    if (latestVolume < prevVolume)
      bearishDetails.push({ indicator: "Volume", pattern: "volume", mode: "live" });
  }

  if (latestIsBeyondLastConfirmedLow) {
    if (checkLiveDivergenceSmoothed(candles, indicators, confirmedLows, "macdHistogram", false))
      bullishDetails.push({ indicator: "MACD", pattern: "peak", mode: "live" });
    if (checkLiveDivergence(candles, indicators, confirmedLows, "rsi", false))
      bullishDetails.push({ indicator: "RSI", pattern: "peak", mode: "live" });
    if (checkLiveDivergence(candles, indicators, confirmedLows, "obv", false))
      bullishDetails.push({ indicator: "OBV", pattern: "peak", mode: "live" });
    if (checkLiveDivergence(candles, indicators, confirmedLows, "mfi", false))
      bullishDetails.push({ indicator: "MFI", pattern: "peak", mode: "live" });

    const prevLow = confirmedLows[confirmedLows.length - 1];
    const latestVolume = candles[latestIdx].volume;
    const prevVolume = candles[prevLow.index].volume;
    if (latestVolume < prevVolume)
      bullishDetails.push({ indicator: "Volume", pattern: "volume", mode: "live" });
  }

  const dedupeIndicators = (details: MatchedIndicatorDetail[]) => {
    const seen = new Set<string>();
    const unique: MatchedIndicatorDetail[] = [];
    for (const d of details) {
      if (!seen.has(d.indicator)) {
        seen.add(d.indicator);
        unique.push(d);
      }
    }
    return unique;
  };

  const bearishUnique = dedupeIndicators(bearishDetails);
  const bullishUnique = dedupeIndicators(bullishDetails);

  if (bearishUnique.length === 0 && bullishUnique.length === 0) {
    return {
      status: "no_divergence",
      message: "未檢測到背離信號",
      symbol, timeframe, bars_available: candles.length, bars_required: minBars,
    };
  }

  let divergenceType: DivergenceType;
  let matchedDetails: MatchedIndicatorDetail[];

  if (bearishUnique.length >= bullishUnique.length) {
    divergenceType = "bearish";
    matchedDetails = bearishUnique;
  } else {
    divergenceType = "bullish";
    matchedDetails = bullishUnique;
  }

  const matchedIndicators = matchedDetails.map(d => d.indicator);
  const matchedCount = matchedIndicators.length;
  const isLive = matchedDetails.some(d => d.mode === "live");

  let strength: Strength;
  if (matchedCount >= 4) strength = "very_strong";
  else if (matchedCount === 3) strength = "strong";
  else if (matchedCount === 2) strength = "moderate";
  else strength = "weak";

  let swingPrice1 = 0, swingPrice2 = 0, swingDate1 = "", swingDate2 = "";
  if (divergenceType === "bearish") {
    if (latestIsBeyondLastConfirmedHigh && isLive) {
      const prevHigh = confirmedHighs[confirmedHighs.length - 1];
      swingPrice1 = prevHigh.price; swingPrice2 = candles[latestIdx].high;
      swingDate1 = prevHigh.date; swingDate2 = candles[latestIdx].date;
    } else if (confirmedHighs.length >= 2) {
      const h1 = confirmedHighs[confirmedHighs.length - 2];
      const h2 = confirmedHighs[confirmedHighs.length - 1];
      swingPrice1 = h1.price; swingPrice2 = h2.price;
      swingDate1 = h1.date; swingDate2 = h2.date;
    }
  } else {
    if (latestIsBeyondLastConfirmedLow && isLive) {
      const prevLow = confirmedLows[confirmedLows.length - 1];
      swingPrice1 = prevLow.price; swingPrice2 = candles[latestIdx].low;
      swingDate1 = prevLow.date; swingDate2 = candles[latestIdx].date;
    } else if (confirmedLows.length >= 2) {
      const l1 = confirmedLows[confirmedLows.length - 2];
      const l2 = confirmedLows[confirmedLows.length - 1];
      swingPrice1 = l1.price; swingPrice2 = l2.price;
      swingDate1 = l1.date; swingDate2 = l2.date;
    }
  }

  return {
    symbol, company_name: companyName, exchange, timeframe,
    divergence_type: divergenceType, strength,
    matched_indicators: matchedIndicators,
    matched_details: matchedDetails,
    matched_count: matchedCount,
    is_live: isLive,
    last_close: lastClose,
    swing_price_1: swingPrice1, swing_price_2: swingPrice2,
    swing_date_1: swingDate1, swing_date_2: swingDate2,
    updated_at: new Date().toISOString(),
    swing_points: confirmedSwings, indicator_values: indicators,
  };
}

export async function fetchCandles(symbol: string, timeframe: Timeframe): Promise<Candle[]> {
  const now = new Date();
  
  let start: Date;
  let interval: "1d" | "1wk" | "30m" | "60m";

  switch (timeframe) {
    case "30m": start = new Date(now.getTime() - 59 * 24 * 60 * 60 * 1000); interval = "30m"; break;
    case "60m": start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); interval = "60m"; break;
    case "1d": start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); interval = "1d"; break;
    case "1wk": start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000 * 5); interval = "1wk"; break;
  }

  const chart = await yahooFinance.chart(symbol, { period1: start, period2: now, interval });
  const quotes = chart?.quotes ?? [];

  return quotes
    .filter((q: any) => q && q.close != null && q.open != null && q.high != null && q.low != null)
    .map((q: any) => ({
      date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 19),
      open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0,
    }));
}

export function getStrengthLabel(strength: Strength): string {
  const labels: Record<Strength, string> = { weak: "弱", moderate: "中", strong: "強", very_strong: "極強" };
  return labels[strength];
}

export function getStrengthColor(strength: Strength): string {
  const colors: Record<Strength, string> = {
    weak: "bg-muted text-muted-foreground border-border",
    moderate: "bg-amber-500/15 text-amber-500 border-amber-500/30",
    strong: "bg-orange-500/20 text-orange-500 border-orange-500/40",
    very_strong: "bg-red-600/20 text-red-500 border-red-500/40",
  };
  return colors[strength];
}