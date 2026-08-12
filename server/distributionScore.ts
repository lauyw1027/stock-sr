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
import { analyzeDivergence, calculateIndicators, findSwingPoints, type Candle, type DivergenceResult, type IndicatorValue, type SwingPoint, type MatchedIndicatorDetail, type InsufficientDataError, type Strength, type DivergenceMode } from "./divergence";

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
  const attemptFetch = async (): Promise<FinraShortVolumeBar[]> => {
    // 明確指定日期範圍：往前抓lookbackDays天的日曆天數再加緩衝，
    // 因為regShoDaily只在交易日產生資料，且FINRA數據本身有約2天延遲
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.ceil(lookbackDays * 1.6) - 5); // 交易日轉日曆天緩衝+延遲緩衝

    const formatDate = (d: Date): string => d.toISOString().slice(0, 10); // YYYY-MM-DD

    const response = await axios.post(
      "https://api.finra.org/data/group/otcMarket/name/regShoDaily",
      {
        limit: lookbackDays * 5, // 每天可能有多個市場代碼(NCTRF/NQTRF/NYTRF)，提高limit避免漏抓
        compareFilters: [
          {
            compareType: "equal",
            fieldName: "securitiesInformationProcessorSymbolIdentifier",
            fieldValue: symbol.toUpperCase(),
          },
        ],
        dateRangeFilters: [
          {
            startDate: formatDate(startDate),
            endDate: formatDate(endDate),
            fieldName: "tradeReportDate",
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

    // Helper to strip double quotes from CSV field values
    const stripQuotes = (value: string): string => {
      return value.trim().replace(/^"|"$/g, "");
    };

    // Parse header with quote stripping
    const headers = lines[0].split(",").map((h) => stripQuotes(h));

    // Find column indices by header name
    const shortVolIdx = headers.findIndex((h) => h === "shortParQuantity");
    const totalVolIdx = headers.findIndex((h) => h === "totalParQuantity");
    const dateIdx = headers.findIndex((h) => h === "tradeReportDate");

    if (shortVolIdx === -1 || totalVolIdx === -1) {
      console.error(`[FinraShortVolume] Could not find expected columns for ${symbol}. Headers:`, headers);
      return [];
    }

    // Log debug info
    console.log(`[FinraShortVolume] CSV header for ${symbol}:`, lines[0]);
    console.log(`[FinraShortVolume] Parsed headers:`, headers);
    console.log(`[FinraShortVolume] Column indices - shortVol: ${shortVolIdx}, totalVol: ${totalVolIdx}, date: ${dateIdx}`);
    console.log(`[FinraShortVolume] Sample data row for ${symbol}:`, lines[1]);

    // Parse CSV data rows with quote stripping
    const result: FinraShortVolumeBar[] = [];
    for (let i = 1; i < lines.length; i++) {
      const rawCols = lines[i].split(",");
      const cols = rawCols.map((c) => stripQuotes(c));

      if (cols.length >= headers.length) {
        const shortVolume = parseFloat(cols[shortVolIdx]) || 0;
        const totalVolume = parseFloat(cols[totalVolIdx]) || 0;
        result.push({
          date: dateIdx !== -1 ? cols[dateIdx] : cols[0],
          shortVolume,
          totalVolume,
          shortRatio: totalVolume > 0 ? shortVolume / totalVolume : 0,
        });
      }
    }

    console.log(`[FinraShortVolume] Fetched ${result.length} raw records for ${symbol}`);

    // 依日期分組加總，避免同一天多個市場代碼被當成獨立記錄
    const groupedByDate = new Map<string, { shortVolume: number; totalVolume: number }>();
    for (const row of result) {
      const existing = groupedByDate.get(row.date) ?? { shortVolume: 0, totalVolume: 0 };
      existing.shortVolume += row.shortVolume;
      existing.totalVolume += row.totalVolume;
      groupedByDate.set(row.date, existing);
    }

    const merged: FinraShortVolumeBar[] = Array.from(groupedByDate.entries())
      .map(([date, v]) => ({
        date,
        shortVolume: v.shortVolume,
        totalVolume: v.totalVolume,
        shortRatio: v.totalVolume > 0 ? v.shortVolume / v.totalVolume : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)) // 依日期升序排列
      .slice(-lookbackDays); // 只取最近lookbackDays個交易日

    console.log(`[FinraShortVolume] Merged ${result.length} raw rows into ${merged.length} trading days for ${symbol}`);

    return merged;
  };

  try {
    return await attemptFetch();
  } catch (firstError: any) {
    console.error(`[FinraShortVolume] First attempt failed for ${symbol}:`, {
      status: firstError?.response?.status ?? "no-http-status",
      message: firstError?.message ?? "unknown error",
    });

    // Wait 1.5 seconds and retry once (FINRA timeouts are usually transient congestion)
    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      const retryResult = await attemptFetch();
      console.log(`[FinraShortVolume] Retry succeeded for ${symbol}`);
      return retryResult;
    } catch (secondError: any) {
      console.error(`[FinraShortVolume] Retry also failed for ${symbol}:`, {
        status: secondError?.response?.status ?? "no-http-status",
        message: secondError?.message ?? "unknown error",
      });
      return [];
    }
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
export function evalIBDDistributionDays(bars: OHLCVBar[], symbol: string = "UNKNOWN"): DistributionDayResult {
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

  console.log(`[DistScore:distributionDays] ${symbol} -`, {
    rawCount,
    offsetCount,
    effectiveCount,
    score,
  });

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
 * 還原特定指標實際用來比較的兩個點，以及該指標在這兩個點上的數值
 * 依divergence_type決定用confirmedHighs（bearish）還是confirmedLows（bullish）
 * 依mode決定用confirmed（兩個舊擺動點互相比較）還是live（今天最新K棒vs最後一個確認擺動點）
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

  // 關鍵修正：依divergence_type決定要看高點還是低點
  const isBearish = divergenceResult.divergence_type === "bearish";
  const swingType = isBearish ? "high" : "low";
  const confirmedPoints = divergenceResult.swing_points.filter((p) => p.type === swingType);

  if (confirmedPoints.length < 1) {
    return null;
  }

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
    // live模式：今天最新K棒 vs 最後一個已確認的擺動點
    const prevPoint = confirmedPoints[confirmedPoints.length - 1];
    const latestIdx = divergenceResult.indicator_values.length - 1;
    const latestBar = bars[bars.length - 1];

    return {
      date1: prevPoint.date,
      date2: divergenceResult.indicator_values[latestIdx]?.date ?? latestBar.date.toString(),
      priceAtSwing1: prevPoint.price,
      // bearish比較用high，bullish比較用low
      priceAtSwing2: isBearish ? latestBar.high : latestBar.low,
      indicatorValue1: divergenceResult.indicator_values[prevPoint.index]?.[indicatorKey] as number,
      indicatorValue2: divergenceResult.indicator_values[latestIdx]?.[indicatorKey] as number,
    };
  }
}

/**
 * Signal 1: nearATH - 股價接近歷史高點
 */
function evalNearATH(bars: OHLCVBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  const recent20 = bars.slice(-20);
  const periodHigh = Math.max(...recent20.map(b => b.high));
  const lastClose = bars[bars.length - 1].close;
  const distancePct = ((periodHigh - lastClose) / periodHigh) * 100;

  console.log(`[DistScore:nearATH] ${symbol} -`, {
    periodHigh: periodHigh.toFixed(2),
    lastClose: lastClose.toFixed(2),
    distancePct: distancePct.toFixed(2),
  });

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
function evalClimaxDownVolume(bars: OHLCVBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  const recent5 = bars.slice(-5);
  const avgVolume = bars.slice(-20, -5).reduce((sum, b) => sum + b.volume, 0) / 15;

  const dailyDetails = recent5.map((bar) => {
    const changePct = ((bar.close - bar.open) / bar.open) * 100;
    const volumeRatio = bar.volume / avgVolume;
    return { changePct: changePct.toFixed(2), volumeRatio: volumeRatio.toFixed(2) };
  });

  console.log(`[DistScore:climaxDownVolume] ${symbol} -`, {
    avgVolume20: avgVolume.toFixed(0),
    recent5Days: dailyDetails,
  });

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

// Helper: Check if result is InsufficientDataError
function isInsufficientData(result: DivergenceResult | InsufficientDataError): result is InsufficientDataError {
  return "status" in result;
}

// Helper: Get divergence analysis result
function getDivergenceAnalysis(bars: OHLCVBar[], symbol: string, companyName: string, exchange: string): DivergenceResult | null {
  const candles = barsToCandles(bars);
  const result = analyzeDivergence(symbol, companyName, exchange, "1d", candles);
  if (isInsufficientData(result)) {
    return null;
  }
  return result;
}

/**
 * Signal 3: obvDivergence - OBV 背離 (使用 divergence.ts 的 analyzeDivergence)
 */
function evalOBVDivergence(
  bars: OHLCVBar[],
  divergenceResult: DivergenceResult | null,
  symbol: string
): { detected: boolean; points: number; detail: string } {
  const obvMatched = divergenceResult?.matched_details.find((d) => d.indicator === "OBV") ?? null;
  const obvComparison = obvMatched
    ? getIndicatorSwingComparison(bars, divergenceResult, "obv", obvMatched.mode)
    : null;

  console.log(`[DistScore:obvDivergence] ${symbol} -`, {
    hasDivergenceResult: !!divergenceResult,
    divergence_type: divergenceResult?.divergence_type ?? "N/A",
    strength: divergenceResult?.strength ?? "N/A",
    matchedIndicators: divergenceResult?.matched_indicators ?? [],
    obvMatchedDetail: obvMatched,
    // OBV自己實際比較的兩個點，不是頂層摘要
    obvSwingComparison: obvComparison
      ? {
          mode: obvMatched?.mode,
          date1: obvComparison.date1,
          date2: obvComparison.date2,
          priceAtSwing1: obvComparison.priceAtSwing1.toFixed(2),
          priceAtSwing2: obvComparison.priceAtSwing2.toFixed(2),
          obvValue1: obvComparison.indicatorValue1,
          obvValue2: obvComparison.indicatorValue2,
        }
      : "N/A",
  });

  if (!divergenceResult) {
    return { detected: false, points: 0, detail: "資料不足，無法判斷背離" };
  }

  // 只關心ATH附近的負背離（bearish），不是ATL的正背離
  if (divergenceResult.divergence_type !== "bearish") {
    return { detected: false, points: 0, detail: "目前無空頭背離訊號" };
  }

  if (!obvMatched) {
    return { detected: false, points: 0, detail: "OBV未出現背離" };
  }

  const liveTag = obvMatched.mode === "live" ? "（即時形成中）" : "（已確認）";
  const strengthMap: Record<string, number> = { weak: 0.4, moderate: 0.6, strong: 0.8, very_strong: 1 };
  const strengthFactor = strengthMap[divergenceResult.strength] ?? 0.5;

  return {
    detected: true,
    points: WEIGHTS.obvDivergence * strengthFactor,
    detail: `OBV出現空頭背離${liveTag}，整體強度：${divergenceResult.strength}`,
  };
}

/**
 * Signal 4: mfiWeak - MFI 轉弱 (使用 divergence.ts 的 analyzeDivergence + 水位 fallback)
 */
function evalMFIWeak(
  bars: OHLCVBar[],
  divergenceResult: DivergenceResult | null,
  symbol: string
): { detected: boolean; points: number; detail: string } {
  const mfiMatched = divergenceResult?.matched_details.find((d) => d.indicator === "MFI") ?? null;
  const candles = barsToCandles(bars);
  const indicators = calculateIndicators(candles);
  const recentMFI = indicators.slice(-10).map((d) => d.mfi);
  const currentMFI = recentMFI[recentMFI.length - 1];
  const avgMFI = recentMFI.length > 1
    ? recentMFI.slice(0, -1).reduce((a, b) => a + b, 0) / (recentMFI.length - 1)
    : null;

  const mfiComparison = mfiMatched
    ? getIndicatorSwingComparison(bars, divergenceResult, "mfi", mfiMatched.mode)
    : null;

  console.log(`[DistScore:mfiWeak] ${symbol} -`, {
    hasDivergenceResult: !!divergenceResult,
    divergence_type: divergenceResult?.divergence_type ?? "N/A",
    mfiMatchedDetail: mfiMatched,
    currentMFI: currentMFI?.toFixed(2) ?? "N/A",
    avgMFI: avgMFI?.toFixed(2) ?? "N/A",
    // MFI自己實際比較的兩個點，不是頂層摘要
    mfiSwingComparison: mfiComparison
      ? {
          mode: mfiMatched?.mode,
          date1: mfiComparison.date1,
          date2: mfiComparison.date2,
          priceAtSwing1: mfiComparison.priceAtSwing1.toFixed(2),
          priceAtSwing2: mfiComparison.priceAtSwing2.toFixed(2),
          mfiValue1: mfiComparison.indicatorValue1,
          mfiValue2: mfiComparison.indicatorValue2,
        }
      : "N/A",
  });

  // 第一層：從analyzeDivergence()結果檢查MFI是否被判定為背離指標之一（含live）
  if (divergenceResult && divergenceResult.divergence_type === "bearish" && mfiMatched) {
    const liveTag = mfiMatched.mode === "live" ? "（即時形成中）" : "（已確認）";
    const strengthMap: Record<string, number> = { weak: 0.4, moderate: 0.6, strong: 0.8, very_strong: 1 };
    const strengthFactor = strengthMap[divergenceResult.strength] ?? 0.5;
    return {
      detected: true,
      points: WEIGHTS.mfiWeak * strengthFactor,
      detail: `MFI出現空頭背離${liveTag}，整體強度：${divergenceResult.strength}`,
    };
  }

  // 第二層：沒有背離型態時，退回檢查MFI絕對水位
  if (recentMFI.length < 5) {
    return { detected: false, points: 0, detail: "資料不足" };
  }

  if (currentMFI < 30 && currentMFI < avgMFI! * 0.8) {
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
function evalDistributionDays(bars: OHLCVBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  const result = evalIBDDistributionDays(bars, symbol);
  
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
function evalFailedBreakout(bars: OHLCVBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  if (bars.length < 30) {
    console.log(`[DistScore:failedBreakout] ${symbol} - 資料不足`);
    return { detected: false, points: 0, detail: "資料不足" };
  }

  // 找近30日最高點
  const recent30 = bars.slice(-30);
  const periodHigh = Math.max(...recent30.map(b => b.high));
  const highIndex = recent30.findIndex(b => b.high === periodHigh);

  let maxPullbackPct = 0;
  if (highIndex < recent30.length - 5) {
    const afterHigh = recent30.slice(highIndex);
    maxPullbackPct = Math.max(...afterHigh.map((b) => ((periodHigh - b.close) / periodHigh) * 100));
  }

  console.log(`[DistScore:failedBreakout] ${symbol} -`, {
    periodHigh: periodHigh.toFixed(2),
    highIndex,
    daysSinceHigh: recent30.length - 1 - highIndex,
    maxPullbackPct: maxPullbackPct.toFixed(2),
  });

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
function evalShortVolumeRatio(finraData: FinraShortVolumeBar[], symbol: string): { detected: boolean; points: number; detail: string } {
  if (!finraData || finraData.length === 0) {
    console.log(`[DistScore:shortVolumeRatio] ${symbol} - 無FINRA資料`);
    return { detected: false, points: 0, detail: "無FINRA資料" };
  }

  const recentData = finraData.slice(-10);
  const avgRatio = recentData.reduce((sum, d) => sum + d.shortRatio, 0) / recentData.length;

  console.log(`[DistScore:shortVolumeRatio] ${symbol} -`, {
    recordCount: finraData.length,
    recentDataUsed: recentData.length,
    avgRatioPct: (avgRatio * 100).toFixed(2),
  });
  
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
export interface DistributionScoreMeta {
  symbol: string;
  companyName: string;
  exchange: string;
}

export function computeDistributionScore(
  bars: OHLCVBar[],
  finraData?: FinraShortVolumeBar[],
  meta?: DistributionScoreMeta
): DistributionScoreResult {
  const signals: DistributionSignal[] = [];
  let totalPoints = 0;
  const symbol = meta?.symbol ?? "UNKNOWN";

  // Safe eval wrapper to catch exceptions
  function safeEval<T extends { detected: boolean; points: number; detail: string }>(
    signalName: string,
    fn: () => T
  ): T {
    try {
      return fn();
    } catch (e: any) {
      console.error(`[DistScore:${signalName}] ${symbol} - EXCEPTION`, {
        message: e?.message ?? "unknown error",
        stack: e?.stack?.split("\n").slice(0, 3).join(" | "),
      });
      return { detected: false, points: 0, detail: `計算失敗: ${e?.message ?? "unknown error"}` } as T;
    }
  }

  // 先計算divergence結果，供OBV和MFI訊號共用
  let divergenceResult: ReturnType<typeof getDivergenceAnalysis> = null;
  if (meta) {
    try {
      divergenceResult = getDivergenceAnalysis(bars, meta.symbol, meta.companyName, meta.exchange);
    } catch (e: any) {
      console.error(`[DistScore:divergenceAnalysis] ${symbol} - EXCEPTION`, {
        message: e?.message ?? "unknown error",
      });
    }
  }

  // Signal 1: nearATH
  const nearATH = safeEval("nearATH", () => evalNearATH(bars, symbol));
  if (nearATH.detected) {
    signals.push({ name: "nearATH", label: "接近高點", detail: nearATH.detail, points: nearATH.points });
    totalPoints += nearATH.points;
  }

  // Signal 2: climaxDownVolume
  const climaxDownVolume = safeEval("climaxDownVolume", () => evalClimaxDownVolume(bars, symbol));
  if (climaxDownVolume.detected) {
    signals.push({ name: "climaxDownVolume", label: "放量下跌", detail: climaxDownVolume.detail, points: climaxDownVolume.points });
    totalPoints += climaxDownVolume.points;
  }

  // Signal 3: obvDivergence (使用analyzeDivergence結果)
  const obvDivergence = safeEval("obvDivergence", () => evalOBVDivergence(bars, divergenceResult, symbol));
  if (obvDivergence.detected) {
    signals.push({ name: "obvDivergence", label: "OBV背離", detail: obvDivergence.detail, points: obvDivergence.points });
    totalPoints += obvDivergence.points;
  }

  // Signal 4: mfiWeak (使用analyzeDivergence結果 + 水位fallback)
  const mfiWeak = safeEval("mfiWeak", () => evalMFIWeak(bars, divergenceResult, symbol));
  if (mfiWeak.detected) {
    signals.push({ name: "mfiWeak", label: "MFI轉弱", detail: mfiWeak.detail, points: mfiWeak.points });
    totalPoints += mfiWeak.points;
  }

  // Signal 5: distributionDays
  const distributionDaysResult = safeEval("distributionDays", () => evalDistributionDays(bars, symbol));
  if (distributionDaysResult.detected) {
    signals.push({ name: "distributionDays", label: "派發日", detail: distributionDaysResult.detail, points: distributionDaysResult.points });
    totalPoints += distributionDaysResult.points;
  }

  // Signal 6: failedBreakout
  const failedBreakout = safeEval("failedBreakout", () => evalFailedBreakout(bars, symbol));
  if (failedBreakout.detected) {
    signals.push({ name: "failedBreakout", label: "失敗突破", detail: failedBreakout.detail, points: failedBreakout.points });
    totalPoints += failedBreakout.points;
  }

  // Signal 7: shortVolumeRatio (only if FINRA data available)
  const hasFinraData = !!finraData && finraData.length > 0;
  const shortVolumeRatio = safeEval("shortVolumeRatio", () => evalShortVolumeRatio(finraData, symbol));
  if (shortVolumeRatio.detected) {
    signals.push({ name: "shortVolumeRatio", label: "放空量大", detail: shortVolumeRatio.detail, points: shortVolumeRatio.points });
    totalPoints += shortVolumeRatio.points;
  } else if (!hasFinraData) {
    signals.push({ name: "shortVolumeRatio", label: "放空量大", detail: "無FINRA資料", points: 0 });
  }

  return {
    totalScore: Math.min(100, totalPoints),
    signals,
    hasShortVolumeData: hasFinraData,
  };
}

/**
 * 獲取單支股票的出貨評分
 * 
 * @param ticker 股票代號
 */

// Helper function to fetch Yahoo Finance chart with retry
async function fetchChartWithRetry(
  ticker: string,
  period1: Date,
  period2: Date
): Promise<any> {
  const attemptFetch = () =>
    yahooFinance.chart(ticker, {
      period1,
      period2,
      interval: "1d",
    });

  try {
    return await attemptFetch();
  } catch (firstError: any) {
    console.error(`[DistributionScore] Yahoo Finance first attempt failed for ${ticker}:`, {
      message: firstError?.message ?? "unknown error",
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      const retryResult = await attemptFetch();
      console.log(`[DistributionScore] Yahoo Finance retry succeeded for ${ticker}`);
      return retryResult;
    } catch (secondError: any) {
      console.error(`[DistributionScore] Yahoo Finance retry also failed for ${ticker}:`, {
        message: secondError?.message ?? "unknown error",
      });
      throw secondError;
    }
  }
}

export async function computeDistributionScoreForTicker(
  ticker: string
): Promise<DistributionScoreResult> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 120); // 120 days for sufficient trading days

    let chart;
    try {
      chart = await fetchChartWithRetry(ticker, startDate, endDate);
    } catch (chartError: any) {
      console.error(`[DistributionScore] Failed to fetch price data for ${ticker} after retry:`, chartError);
      return {
        totalScore: 0,
        signals: [],
        hasShortVolumeData: false,
        error: `無法取得${ticker}的歷史股價資料，Yahoo Finance連線逾時，請稍後再試`,
      };
    }

    const rawQuotes = chart?.quotes ?? [];

    // 先過濾掉含 null/undefined 的殘缺資料（通常是當日或前一交易日尚未結算的K棒）
    const droppedBars: any[] = [];
    const validQuotes = rawQuotes.filter((q: any) => {
      const isValid =
        q.close !== null && q.close !== undefined &&
        q.open !== null && q.open !== undefined &&
        q.high !== null && q.high !== undefined &&
        q.low !== null && q.low !== undefined;
      if (!isValid) {
        droppedBars.push({
          date: q.date,
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume,
        });
      }
      return isValid;
    });

    if (droppedBars.length > 0) {
      console.log(`[DistributionScore] Dropped ${droppedBars.length} incomplete bar(s) for ${ticker}:`, droppedBars);
    }

    const bars: OHLCVBar[] = validQuotes.map((q: any) => ({
      date: q.date,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume ?? 0, // volume可以容忍0，但OHLC不行
    }));

    // Debug: 印出過濾後bars陣列的頭尾資訊，方便核對
    console.log(`[DistributionScore] Final bars for ${ticker}:`, {
      totalBars: bars.length,
      firstDate: bars[0]?.date,
      lastDate: bars[bars.length - 1]?.date,
      overallMaxHigh: Math.max(...bars.map((b) => b.high)),
      overallMaxHighDate: bars.find((b) => b.high === Math.max(...bars.map((b2) => b2.high)))?.date,
      last20MaxHigh: Math.max(...bars.slice(-20).map((b) => b.high)),
      last30MaxHigh: Math.max(...bars.slice(-30).map((b) => b.high)),
    });

    if (bars.length < 50) {
      return {
        totalScore: 0,
        signals: [],
        hasShortVolumeData: false,
        error: `資料不足(僅${bars.length}個交易日)，無法計算出貨評分`,
      };
    }

    // 嘗試獲取 FINRA 數據
    let finraData: FinraShortVolumeBar[] | undefined;
    try {
      finraData = await fetchFinraShortVolume(ticker, 25);
    } catch (e) {
      console.error(`[DistributionScore] FINRA data fetch failed for ${ticker}:`, e);
    }

    const result = computeDistributionScore(bars, finraData, {
      symbol: ticker,
      companyName: ticker, // 使用ticker作為companyName佔位
      exchange: "NASDAQ",  // 預設交易所
    });
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