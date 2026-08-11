/**
 * distributionScore.ts — 出貨評分計算模組
 * 
 * 用於評估股票在創新高後的派發風險
 * 只在使用者點擊查看詳情時才計算，不在批量掃描時執行
 * 
 * 七項訊號：nearATH, climaxDownVolume, obvDivergence, mfiWeak, distributionDays, failedBreakout, shortVolumeRatio
 */

import { yahooFinance } from "./stocks";
import axios from "axios";
import { calculateIndicators, findSwingPoints, type Candle, type IndicatorValue, type SwingPoint } from "./divergence";

// ============ Types ============

export interface OHLCVBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FinraShortVolumeBar {
  date: string;
  shortVolume: number;
  totalVolume: number;
  shortRatio: number;
}

export interface DistributionSignal {
  name: string;
  label: string;
  detail: string;
  points: number;
}

export interface DistributionScoreResult {
  totalScore: number;
  signals: DistributionSignal[];
  hasShortVolumeData: boolean;
  error?: string;
}

// ============ Weight Configuration (Fixed 100) ============

const WEIGHTS = {
  nearATH: 12,
  climaxDownVolume: 13,
  obvDivergence: 18,
  mfiWeak: 18,
  distributionDays: 15,
  failedBreakout: 12,
  shortVolumeRatio: 12,
};

// Verify weight sum equals 100
const WEIGHT_SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (WEIGHT_SUM !== 100) {
  console.error(`[DistributionScore] WARNING: Weight sum is ${WEIGHT_SUM}, expected 100`);
}

// ============ FINRA Short Volume Fetching ============

/**
 * 從 FINRA Reg SHO Daily Short Sale Volume API 取得放空成交量數據
 * API: https://api.finra.org/data/group/otcMarket/name/regShoDaily
 * 
 * 注意：此為免費公開資料集，不需要 OAuth 認證即可查詢
 * 數據有 2 天延遲，且只提供每週兩次更新
 */
export async function fetchFinraShortVolume(
  symbol: string,
  lookbackDays: number = 25
): Promise<FinraShortVolumeBar[]> {
  try {
    const response = await axios.post(
      "https://api.finra.org/data/group/otcMarket/name/regShoDaily",
      {
        limit: lookbackDays,
        compareFilters: [
          {
            compareType: "equal",
            fieldName: "securitiesInformationProcessorSymbolIdentifier",
            fieldValue: symbol.toUpperCase(),
          },
        ],
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      }
    );

    // Response is CSV format, need to parse
    const csvText = response.data;
    if (typeof csvText !== "string") {
      console.error(`[FinraShortVolume] Unexpected response type for ${symbol}:`, typeof csvText);
      return [];
    }

    const lines = csvText.trim().split("\n");
    if (lines.length < 2) {
      console.log(`[FinraShortVolume] No data returned for ${symbol}`);
      return [];
    }

    // Parse CSV - skip header row
    const result: FinraShortVolumeBar[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length >= 5) {
        const shortVolume = parseFloat(cols[2]) || 0;
        const totalVolume = parseFloat(cols[4]) || 0;
        result.push({
          date: cols[0], // tradeReportDate
          shortVolume,
          totalVolume,
          shortRatio: totalVolume > 0 ? shortVolume / totalVolume : 0,
        });
      }
    }

    console.log(`[FinraShortVolume] Fetched ${result.length} records for ${symbol}`);
    return result;

  } catch (e: any) {
    console.error(`[FinraShortVolume] Failed to fetch data for ${symbol}:`, {
      status: e?.response?.status ?? "no-http-status",
      message: e?.message ?? "unknown error",
    });
    // 返回空陣列，呼叫方需處理「無 FINRA 資料」的情況
    return [];
  }
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

// ============ IBD Distribution Day Evaluation ============

export interface DistributionDayResult {
  count: number;
  offsetCount: number;
  effectiveCount: number;
  score: number;
  detail: string;
}

/**
 * 評估 IBD Distribution Days
 * - 25日滾動視窗
 * - 跌幅 >= 0.2% 且成交量 > 前日 = Distribution Day
 * - 漲幅 >= 1.5% 且成交量 > 前日 = Rally Day (可抵銷)
 * - 兩條抵銷規則
 */
export function evalIBDDistributionDays(bars: OHLCVBar[]): DistributionDayResult {
  const windowBars = bars.slice(-25);
  
  if (windowBars.length < 25) {
    return { count: 0, offsetCount: 0, effectiveCount: 0, score: 0, detail: "資料不足25個交易日，無法計算" };
  }

  interface DayFlag {
    index: number;
    isDistribution: boolean;
    isRally: boolean;
    close: number;
    offset: boolean;
  }

  const flags: DayFlag[] = windowBars.map((bar, i) => {
    if (i === 0) {
      return { index: i, isDistribution: false, isRally: false, close: bar.close, offset: false };
    }

    const prevClose = windowBars[i - 1].close;
    const prevVolume = windowBars[i - 1].volume;
    const changePct = ((bar.close - prevClose) / prevClose) * 100;

    const isDistribution = changePct <= -0.2 && bar.volume > prevVolume;
    const isRally = changePct >= 1.5 && bar.volume > prevVolume;

    return { index: i, isDistribution, isRally, close: bar.close, offset: false };
  });

  const rawCount = flags.filter((f) => f.isDistribution).length;

  // 抵銷規則一：強力反彈日抵銷視窗內最舊的一個尚未抵銷的 Distribution Day
  for (const f of flags) {
    if (f.isRally) {
      const oldestUnoffset = flags.find((d) => d.isDistribution && !d.offset);
      if (oldestUnoffset) {
        oldestUnoffset.offset = true;
      }
    }
  }

  // 抵銷規則二：兩個 Distribution Day 相隔 3 個交易日內，且後者收盤價高於前者，前者抵銷
  const distributionFlags = flags.filter((f) => f.isDistribution);
  for (let i = 0; i < distributionFlags.length - 1; i++) {
    const curr = distributionFlags[i];
    const next = distributionFlags[i + 1];
    if (!curr.offset && next.index - curr.index <= 3 && next.close > curr.close) {
      curr.offset = true;
    }
  }

  const offsetCount = flags.filter((f) => f.isDistribution && f.offset).length;
  const effectiveCount = rawCount - offsetCount;

  let score = 0;
  let riskLabel = "低風險";

  if (effectiveCount >= 6) {
    score = 1;
    riskLabel = "高風險";
  } else if (effectiveCount >= 4) {
    score = 0.5;
    riskLabel = "中風險";
  }

  return {
    count: rawCount,
    offsetCount,
    effectiveCount,
    score,
    detail: `25日內${rawCount}個派發日，抵銷${offsetCount}個，有效${effectiveCount}個，屬${riskLabel}`,
  };
}

// ============ Signal Evaluation Functions ============

/**
 * Signal 1: nearATH - 股價接近歷史高點
 */
function evalNearATH(bars: OHLCVBar[]): { detected: boolean; points: number; detail: string } {
  const recent20 = bars.slice(-20);
  const periodHigh = Math.max(...recent20.map(b => b.high));
  const lastClose = bars[bars.length - 1].close;
  
  const distancePct = ((periodHigh - lastClose) / periodHigh) * 100;
  
  if (distancePct <= 2) {
    return { detected: true, points: WEIGHTS.nearATH, detail: `距${periodHigh.toFixed(2)}高低於2%` };
  } else if (distancePct <= 5) {
    return { detected: true, points: WEIGHTS.nearATH * 0.6, detail: `距${periodHigh.toFixed(2)}高低於5%` };
  }
  
  return { detected: false, points: 0, detail: `距高點${distancePct.toFixed(1)}%` };
}

/**
 * Signal 2: climaxDownVolume - 放量下跌
 */
function evalClimaxDownVolume(bars: OHLCVBar[]): { detected: boolean; points: number; detail: string } {
  const recent5 = bars.slice(-5);
  const avgVolume = bars.slice(-20, -5).reduce((sum, b) => sum + b.volume, 0) / 15;
  
  let maxClimax = 0;
  let climaxDetail = "";
  
  for (const bar of recent5) {
    const changePct = ((bar.close - bar.open) / bar.open) * 100;
    const volumeRatio = bar.volume / avgVolume;
    
    if (changePct <= -3 && volumeRatio > 2) {
      const score = Math.min(WEIGHTS.climaxDownVolume, WEIGHTS.climaxDownVolume * volumeRatio / 3);
      if (score > maxClimax) {
        maxClimax = score;
        climaxDetail = `單日跌${Math.abs(changePct).toFixed(1)}%且量能${volumeRatio.toFixed(1)}x`;
      }
    }
  }
  
  if (maxClimax > 0) {
    return { detected: true, points: maxClimax, detail: climaxDetail };
  }
  
  return { detected: false, points: 0, detail: "無明顯放量下跌" };
}

/**
 * Signal 3: obvDivergence - OBV 背離 (使用 divergence.ts 的 findSwingPoints)
 */
function evalOBVDivergence(bars: OHLCVBar[]): { detected: boolean; points: number; detail: string } {
  if (bars.length < 30) {
    return { detected: false, points: 0, detail: "資料不足" };
  }

  const candles = barsToCandles(bars);
  const indicators = calculateIndicators(candles);
  const swingPoints = findSwingPoints(candles, 5);

  const confirmedHighs = swingPoints.filter((p) => p.type === "high");

  if (confirmedHighs.length < 2) {
    return { detected: false, points: 0, detail: "尚無足夠的swing high可比對" };
  }

  const h1 = confirmedHighs[confirmedHighs.length - 2];
  const h2 = confirmedHighs[confirmedHighs.length - 1];

  const obvAtH1 = indicators[h1.index]?.obv ?? 0;
  const obvAtH2 = indicators[h2.index]?.obv ?? 0;

  // 價格創新高（h2 > h1）但OBV沒有同步創新高（h2的OBV反而更低）
  const priceHigher = h2.price > h1.price;
  const obvLower = obvAtH2 < obvAtH1;

  if (priceHigher && obvLower) {
    const obvDropPct = obvAtH1 !== 0 ? Math.abs((obvAtH2 - obvAtH1) / obvAtH1) * 100 : 0;
    
    if (obvDropPct > 15) {
      return { 
        detected: true, 
        points: WEIGHTS.obvDivergence, 
        detail: `價格創高($${h1.price.toFixed(2)}→$${h2.price.toFixed(2)})但OBV下降${obvDropPct.toFixed(0)}%` 
      };
    }
    return { 
      detected: true, 
      points: WEIGHTS.obvDivergence * 0.5, 
      detail: `價格創高但OBV略降${obvDropPct.toFixed(0)}%` 
    };
  }

  return { detected: false, points: 0, detail: "無OBV背離" };
}

/**
 * Signal 4: mfiWeak - MFI 轉弱 (使用 divergence.ts 的 calculateIndicators)
 */
function evalMFIWeak(bars: OHLCVBar[]): { detected: boolean; points: number; detail: string } {
  if (bars.length < 30) {
    return { detected: false, points: 0, detail: "資料不足" };
  }

  const candles = barsToCandles(bars);
  const indicators = calculateIndicators(candles);
  const swingPoints = findSwingPoints(candles, 5);
  const confirmedHighs = swingPoints.filter((p) => p.type === "high");

  // 第一層：優先檢查MFI背離（價格創新高但MFI沒有同步創新高）
  if (confirmedHighs.length >= 2) {
    const h1 = confirmedHighs[confirmedHighs.length - 2];
    const h2 = confirmedHighs[confirmedHighs.length - 1];
    const mfiAtH1 = indicators[h1.index]?.mfi ?? 50;
    const mfiAtH2 = indicators[h2.index]?.mfi ?? 50;

    const priceHigher = h2.price > h1.price;
    const mfiLower = mfiAtH2 < mfiAtH1;

    if (priceHigher && mfiLower) {
      const mfiDropPts = mfiAtH1 - mfiAtH2;
      if (mfiDropPts > 10) {
        return {
          detected: true,
          points: WEIGHTS.mfiWeak,
          detail: `價格創高($${h1.price.toFixed(2)}→$${h2.price.toFixed(2)})但MFI從${mfiAtH1.toFixed(0)}降至${mfiAtH2.toFixed(0)}`,
        };
      }
      return {
        detected: true,
        points: WEIGHTS.mfiWeak * 0.6,
        detail: `價格創高但MFI從${mfiAtH1.toFixed(0)}略降至${mfiAtH2.toFixed(0)}`,
      };
    }
  }

  // 第二層：沒有背離型態時，退回檢查MFI絕對水位
  const recentMFI = indicators.slice(-10).map(d => d.mfi);
  if (recentMFI.length < 5) {
    return { detected: false, points: 0, detail: "資料不足" };
  }

  const currentMFI = recentMFI[recentMFI.length - 1];
  const avgMFI = recentMFI.slice(0, -1).reduce((a, b) => a + b, 0) / (recentMFI.length - 1);

  if (currentMFI < 30 && currentMFI < avgMFI * 0.8) {
    return {
      detected: true,
      points: WEIGHTS.mfiWeak * 0.5,
      detail: `MFI=${currentMFI.toFixed(0)}低於30且低於均值（無明確背離型態）`,
    };
  }

  if (currentMFI < 50) {
    return {
      detected: true,
      points: WEIGHTS.mfiWeak * 0.25,
      detail: `MFI=${currentMFI.toFixed(0)}低於50（無明確背離型態）`,
    };
  }

  return { detected: false, points: 0, detail: `MFI=${currentMFI.toFixed(0)}正常` };
}

/**
 * Signal 5: distributionDays - IBD Distribution Days
 */
function evalDistributionDays(bars: OHLCVBar[]): { detected: boolean; points: number; detail: string } {
  const result = evalIBDDistributionDays(bars);
  
  if (result.effectiveCount >= 6) {
    return { detected: true, points: WEIGHTS.distributionDays, detail: result.detail };
  } else if (result.effectiveCount >= 4) {
    return { detected: true, points: WEIGHTS.distributionDays * 0.7, detail: result.detail };
  } else if (result.effectiveCount >= 2) {
    return { detected: true, points: WEIGHTS.distributionDays * 0.4, detail: result.detail };
  }
  
  return { detected: false, points: 0, detail: result.detail };
}

/**
 * Signal 6: failedBreakout - 失敗突破
 */
function evalFailedBreakout(bars: OHLCVBar[]): { detected: boolean; points: number; detail: string } {
  if (bars.length < 30) {
    return { detected: false, points: 0, detail: "資料不足" };
  }
  
  // 找近30日最高點
  const recent30 = bars.slice(-30);
  const periodHigh = Math.max(...recent30.map(b => b.high));
  const highIndex = recent30.findIndex(b => b.high === periodHigh);
  
  // 檢查是否有突破後回落
  if (highIndex < recent30.length - 5) { // 至少5天前
    const afterHigh = recent30.slice(highIndex);
    const failed = afterHigh.some(b => b.close < periodHigh * 0.97); // 回落3%以上
    
    if (failed) {
      return { detected: true, points: WEIGHTS.failedBreakout, detail: `突破${periodHigh.toFixed(2)}後回落超過3%` };
    }
  }
  
  return { detected: false, points: 0, detail: "無失敗突破訊號" };
}

/**
 * Signal 7: shortVolumeRatio - 放空成交量比率
 */
function evalShortVolumeRatio(finraData: FinraShortVolumeBar[]): { detected: boolean; points: number; detail: string } {
  if (!finraData || finraData.length === 0) {
    return { detected: false, points: 0, detail: "無FINRA資料" };
  }
  
  const recentData = finraData.slice(-10);
  const avgRatio = recentData.reduce((sum, d) => sum + d.shortRatio, 0) / recentData.length;
  
  // shortVolumeRatio 最多貢獻 weight * 0.5 = 6 分
  if (avgRatio > 0.4) {
    return { detected: true, points: WEIGHTS.shortVolumeRatio * 0.5, detail: `放空量平均佔${(avgRatio * 100).toFixed(1)}%` };
  } else if (avgRatio > 0.3) {
    return { detected: true, points: WEIGHTS.shortVolumeRatio * 0.3, detail: `放空量平均佔${(avgRatio * 100).toFixed(1)}%` };
  }
  
  return { detected: false, points: 0, detail: `放空量佔比${(avgRatio * 100).toFixed(1)}%正常` };
}

// ============ Main Distribution Score Computation ============

/**
 * 計算出貨評分 - 七項訊號完整實作
 * 
 * 權重配置（總和=100）：
 * - nearATH: 12
 * - climaxDownVolume: 13
 * - obvDivergence: 18
 * - mfiWeak: 18
 * - distributionDays: 15
 * - failedBreakout: 12
 * - shortVolumeRatio: 12
 */
export function computeDistributionScore(
  bars: OHLCVBar[],
  finraData?: FinraShortVolumeBar[]
): DistributionScoreResult {
  const signals: DistributionSignal[] = [];
  let totalPoints = 0;

  // Signal 1: nearATH
  const nearATH = evalNearATH(bars);
  if (nearATH.detected) {
    signals.push({ name: "nearATH", label: "接近高點", detail: nearATH.detail, points: nearATH.points });
    totalPoints += nearATH.points;
  }

  // Signal 2: climaxDownVolume
  const climaxDownVolume = evalClimaxDownVolume(bars);
  if (climaxDownVolume.detected) {
    signals.push({ name: "climaxDownVolume", label: "放量下跌", detail: climaxDownVolume.detail, points: climaxDownVolume.points });
    totalPoints += climaxDownVolume.points;
  }

  // Signal 3: obvDivergence
  const obvDivergence = evalOBVDivergence(bars);
  if (obvDivergence.detected) {
    signals.push({ name: "obvDivergence", label: "OBV背離", detail: obvDivergence.detail, points: obvDivergence.points });
    totalPoints += obvDivergence.points;
  }

  // Signal 4: mfiWeak
  const mfiWeak = evalMFIWeak(bars);
  if (mfiWeak.detected) {
    signals.push({ name: "mfiWeak", label: "MFI轉弱", detail: mfiWeak.detail, points: mfiWeak.points });
    totalPoints += mfiWeak.points;
  }

  // Signal 5: distributionDays
  const distributionDays = evalDistributionDays(bars);
  if (distributionDays.detected) {
    signals.push({ name: "distributionDays", label: "派發日", detail: distributionDays.detail, points: distributionDays.points });
    totalPoints += distributionDays.points;
  }

  // Signal 6: failedBreakout
  const failedBreakout = evalFailedBreakout(bars);
  if (failedBreakout.detected) {
    signals.push({ name: "failedBreakout", label: "失敗突破", detail: failedBreakout.detail, points: failedBreakout.points });
    totalPoints += failedBreakout.points;
  }

  // Signal 7: shortVolumeRatio (only if FINRA data available)
  const hasFinraData = finraData && finraData.length > 0;
  const shortVolumeRatio = evalShortVolumeRatio(finraData);
  if (shortVolumeRatio.detected) {
    signals.push({ name: "shortVolumeRatio", label: "放空量大", detail: shortVolumeRatio.detail, points: shortVolumeRatio.points });
    totalPoints += shortVolumeRatio.points;
  } else if (!hasFinraData) {
    signals.push({ name: "shortVolumeRatio", label: "放空量大", detail: "無FINRA資料", points: 0 });
  }

  return {
    totalScore: Math.min(100, totalPoints),
    signals,
    hasShortVolumeData: !!hasFinraData,
  };
}

/**
 * 獲取單支股票的出貨評分
 * 
 * @param ticker 股票代號
 */
export async function computeDistributionScoreForTicker(
  ticker: string
): Promise<DistributionScoreResult> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 60);

    const chart = await yahooFinance.chart(ticker, {
      period1: startDate,
      period2: endDate,
      interval: "1d",
    });

    const bars: OHLCVBar[] = (chart?.quotes ?? []).map((q: any) => ({
      date: q.date,
      open: q.open ?? 0,
      high: q.high ?? 0,
      low: q.low ?? 0,
      close: q.close ?? 0,
      volume: q.volume ?? 0,
    }));

    if (bars.length < 30) {
      return {
        totalScore: 0,
        signals: [],
        hasShortVolumeData: false,
        error: "資料不足，無法計算出貨評分",
      };
    }

    // 嘗試獲取 FINRA 數據
    let finraData: FinraShortVolumeBar[] | undefined;
    try {
      finraData = await fetchFinraShortVolume(ticker, 25);
    } catch (e) {
      console.error(`[DistributionScore] FINRA data fetch failed for ${ticker}:`, e);
    }

    const result = computeDistributionScore(bars, finraData);
    return result;

  } catch (e: any) {
    console.error(`[DistributionScore] Error computing score for ${ticker}:`, e);
    return {
      totalScore: 0,
      signals: [],
      hasShortVolumeData: false,
      error: `計算出貨評分時發生錯誤: ${e.message}`,
    };
  }
}