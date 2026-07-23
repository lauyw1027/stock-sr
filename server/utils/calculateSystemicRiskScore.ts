/**
 * AI 基建系統性信用風險監控 - 核心計分模組
 * 模擬真正的系統性風險早期預警框架（跨信用市場、流動性、產業鏈多板塊交叉驗證）
 */

import type { SectorInputs, SectorScore, SystemicRiskResult, SignalLevel } from "./creditMonitorTypes.js";

// ============================================================================
// 類型定義
// ============================================================================

export { SignalLevel, SectorInputs, SectorScore, SystemicRiskResult };

// ============================================================================
// 工具函式
// ============================================================================

/**
 * 根據閾值計算分數（0/50/100 三檔）
 * @param value - 指標值
 * @param yellowThreshold - 黃燈門檻
 * @param redThreshold - 紅燈門檻
 * @param direction - 'gte' (大於等於) 或 'lte' (小於等於)
 */
function calculateScore(
  value: number | null,
  yellowThreshold: number,
  redThreshold: number,
  direction: 'gte' | 'lte'
): number {
  if (value === null) return 0;
  
  if (direction === 'gte') {
    if (value >= redThreshold) return 100;
    if (value >= yellowThreshold) return 50;
    return 0;
  } else {
    if (value <= redThreshold) return 100;
    if (value <= yellowThreshold) return 50;
    return 0;
  }
}

/**
 * 將分數轉換為燈號
 */
function scoreToSignal(score: number): SignalLevel {
  if (score >= 60) return '紅燈';
  if (score >= 35) return '黃燈';
  return '綠燈';
}

/**
 * 計算平均值（忽略 null）
 */
function average(...values: (number | null)[]): number {
  const validValues = values.filter((v): v is number => v !== null);
  if (validValues.length === 0) return 0;
  return validValues.reduce((a, b) => a + b, 0) / validValues.length;
}

// ============================================================================
// 各板塊計分邏輯
// ============================================================================

/**
 * 板塊A：信用市場（權重 35%）
 * - 高收益債利差 OAS（FRED: BAMLH0A0HYM2）
 * - 投資級債利差 OAS（FRED: BAMLC0A0CM）
 * - ETF: HYG, JNK, LQD, BKLN
 */
function calculateCreditMarketScore(inputs: SectorInputs): SectorScore {
  const { hyOasDelta, igOasDelta, hygChange, jnkChange, lqdChange, bklnChange } = inputs;
  
  const scores = [
    // 高收益債利差日變化：黃燈>=0.08，紅燈>=0.20（gte）
    calculateScore(hyOasDelta, 0.08, 0.20, 'gte'),
    // 投資級債利差日變化：黃燈>=0.03，紅燈>=0.08（gte）
    calculateScore(igOasDelta, 0.03, 0.08, 'gte'),
    // HYG日變化(%)：黃燈<=-0.5，紅燈<=-1.5（lte）
    calculateScore(hygChange, -0.5, -1.5, 'lte'),
    // JNK日變化(%)：黃燈<=-0.5，紅燈<=-1.5（lte）
    calculateScore(jnkChange, -0.5, -1.5, 'lte'),
    // LQD日變化(%)：黃燈<=-0.3，紅燈<=-1.0（lte）
    calculateScore(lqdChange, -0.3, -1.0, 'lte'),
    // BKLN日變化(%)：黃燈<=-0.3，紅燈<=-1.0（lte）
    calculateScore(bklnChange, -0.3, -1.0, 'lte'),
  ];
  
  const score = average(...scores);
  return {
    score,
    signal: scoreToSignal(score),
  };
}

/**
 * 板塊B：流動性/壓力（權重 25%）
 * - OFR 金融壓力指數（FRED: OFRFSCI）
 * - VIX
 * - 美元指數（DX-Y.NYB）
 */
function calculateLiquidityStressScore(inputs: SectorInputs): SectorScore {
  const { ofrFsi, vix, dxyChange } = inputs;
  
  const scores = [
    // STLFSI4（St. Louis Fed Financial Stress Index）：黃燈>=-0.3，紅燈>=0（gte）
    // 註：STLFSI4 為週資料，負值表示低壓力，正值表示高壓力
    calculateScore(ofrFsi, -0.3, 0, 'gte'),
    // VIX：黃燈>=18，紅燈>=22（gte）
    calculateScore(vix, 18, 22, 'gte'),
    // 美元指數日變化(%)：黃燈>=0.5，紅燈>=1.2（gte）
    calculateScore(dxyChange, 0.5, 1.2, 'gte'),
  ];
  
  const score = average(...scores);
  return {
    score,
    signal: scoreToSignal(score),
  };
}

/**
 * 板塊C：AI基建核心（權重 20%）
 * - CRWV, NBIS, ORCL, VRT, DLR, EQIX
 */
function calculateAIInfraCoreScore(inputs: SectorInputs): SectorScore {
  const { crwvChange, nbisChange, orclChange, vrtChange, dlrChange, eqixChange } = inputs;
  
  const scores = [
    // CRWV日變化(%)：黃燈<=-3，紅燈<=-8（lte）
    calculateScore(crwvChange, -3, -8, 'lte'),
    // NBIS日變化(%)：黃燈<=-3，紅燈<=-8（lte）
    calculateScore(nbisChange, -3, -8, 'lte'),
    // ORCL日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(orclChange, -2, -5, 'lte'),
    // VRT日變化(%)：黃燈<=-3，紅燈<=-7（lte）
    calculateScore(vrtChange, -3, -7, 'lte'),
    // DLR日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(dlrChange, -2, -5, 'lte'),
    // EQIX日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(eqixChange, -2, -5, 'lte'),
  ];
  
  const score = average(...scores);
  return {
    score,
    signal: scoreToSignal(score),
  };
}

/**
 * 板塊D：上游供應鏈（權重 10%）
 * - NVDA, AMD, AVGO, TSM
 */
function calculateChipSupplyChainScore(inputs: SectorInputs): SectorScore {
  const { nvdaChange, amdChange, avgoChange, tsmChange } = inputs;
  
  const scores = [
    // NVDA日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(nvdaChange, -2, -5, 'lte'),
    // AMD日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(amdChange, -2, -5, 'lte'),
    // AVGO日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(avgoChange, -2, -5, 'lte'),
    // TSM日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(tsmChange, -2, -5, 'lte'),
  ];
  
  const score = average(...scores);
  return {
    score,
    signal: scoreToSignal(score),
  };
}

/**
 * 板塊E：資金供給端／私募信貸（權重 10%）
 * - ARCC, BXSL, OBDC
 */
function calculatePrivateCreditFundingScore(inputs: SectorInputs): SectorScore {
  const { arccChange, bxslChange, obdcChange } = inputs;
  
  const scores = [
    // ARCC日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(arccChange, -2, -5, 'lte'),
    // BXSL日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(bxslChange, -2, -5, 'lte'),
    // OBDC日變化(%)：黃燈<=-2，紅燈<=-5（lte）
    calculateScore(obdcChange, -2, -5, 'lte'),
  ];
  
  const score = average(...scores);
  return {
    score,
    signal: scoreToSignal(score),
  };
}

// ============================================================================
// 主函式：計算系統性信用風險分數
// ============================================================================

/**
 * 計算系統性信用風險分數
 * @param inputs - 所有指標輸入值
 * @returns 包含各板塊分數、加權總分、最終燈號與觸發規則
 */
export function calculateSystemicRiskScore(inputs: SectorInputs): SystemicRiskResult {
  const triggeredRules: string[] = [];
  
  // 計算各板塊分數
  const creditMarket = calculateCreditMarketScore(inputs);
  const liquidityStress = calculateLiquidityStressScore(inputs);
  const aiInfraCore = calculateAIInfraCoreScore(inputs);
  const chipSupplyChain = calculateChipSupplyChainScore(inputs);
  const privateCreditFunding = calculatePrivateCreditFundingScore(inputs);
  
  // 計算加權總分
  const weightedTotal = 
    creditMarket.score * 0.35 +
    liquidityStress.score * 0.25 +
    aiInfraCore.score * 0.20 +
    chipSupplyChain.score * 0.10 +
    privateCreditFunding.score * 0.10;
  
  // 基礎燈號（依加權總分）
  let finalSignal: SignalLevel;
  if (weightedTotal >= 60) {
    finalSignal = '紅燈';
  } else if (weightedTotal >= 35) {
    finalSignal = '黃燈';
  } else {
    finalSignal = '綠燈';
  }
  
  // ============================================================================
  // 交叉確認規則
  // ============================================================================
  
  // 規則1：封頂規則
  // 若信用市場板塊分數 < 20，即使加權總分達到紅燈門檻，最終燈號最高只能是黃燈
  if (creditMarket.score < 20 && finalSignal === '紅燈') {
    finalSignal = '黃燈';
    triggeredRules.push('Rule1: 封頂規則 - 信用市場分數 < 20，紅燈降為黃燈');
  }
  
  // 規則2：升級規則A
  // 若信用市場板塊分數 >= 25 且流動性/壓力板塊分數 >= 15，則最終燈號升一級
  if (creditMarket.score >= 25 && liquidityStress.score >= 15) {
    if (finalSignal === '綠燈') {
      finalSignal = '黃燈';
      triggeredRules.push('Rule2: 升級規則A - 信用市場>=25 且 流動性/壓力>=15，綠燈升為黃燈');
    } else if (finalSignal === '黃燈') {
      finalSignal = '紅燈';
      triggeredRules.push('Rule2: 升級規則A - 信用市場>=25 且 流動性/壓力>=15，黃燈升為紅燈');
    }
  }
  
  // 規則3：升級規則B
  // 若「AI基建核心」「上游供應鏈」「資金供給端」三個產業板塊中，
  // 有兩個以上板塊分數達到 >= 35，則最終燈號再升一級
  const industrySectors = [
    { name: 'AI基建核心', score: aiInfraCore.score },
    { name: '上游供應鏈', score: chipSupplyChain.score },
    { name: '資金供給端', score: privateCreditFunding.score },
  ];
  
  const sectorsAtYellowOrAbove = industrySectors.filter(s => s.score >= 35);
  
  if (sectorsAtYellowOrAbove.length >= 2) {
    if (finalSignal === '綠燈') {
      finalSignal = '黃燈';
      triggeredRules.push(`Rule3: 升級規則B - ${sectorsAtYellowOrAbove.map(s => s.name).join('、')} 達到黃燈，綠燈升為黃燈`);
    } else if (finalSignal === '黃燈') {
      finalSignal = '紅燈';
      triggeredRules.push(`Rule3: 升級規則B - ${sectorsAtYellowOrAbove.map(s => s.name).join('、')} 達到黃燈，黃燈升為紅燈`);
    }
  }
  
  return {
    sectorScores: {
      creditMarket,
      liquidityStress,
      aiInfraCore,
      chipSupplyChain,
      privateCreditFunding,
    },
    weightedTotal: Math.round(weightedTotal * 10) / 10, // 保留一位小數
    finalSignal,
    triggeredRules,
  };
}

/**
 * 取得季度標籤（根據日期）
 * @param dateStr - ISO 日期字串 (YYYY-MM-DD)
 * @returns 季度標籤 (例如 "2026Q3")
 */
export function getQuarterLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  
  let quarter: string;
  if (month >= 1 && month <= 3) {
    quarter = 'Q1';
  } else if (month >= 4 && month <= 6) {
    quarter = 'Q2';
  } else if (month >= 7 && month <= 9) {
    quarter = 'Q3';
  } else {
    quarter = 'Q4';
  }
  
  return `${year}${quarter}`;
}