/**
 * AI 基建系統性信用風險監控 - 共用類型定義
 * Server 與 Client 共用
 */

// ============================================================================
// 信號等級
// ============================================================================

export type SignalLevel = '綠燈' | '黃燈' | '紅燈';

// ============================================================================
// 板塊輸入資料
// ============================================================================

export interface SectorInputs {
  // 板塊A：信用市場
  hyOasDelta: number | null;   // 高收益債利差日變化
  igOasDelta: number | null;   // 投資級債利差日變化
  hygChange: number | null;    // HYG 日變化(%)
  jnkChange: number | null;    // JNK 日變化(%)
  lqdChange: number | null;    // LQD 日變化(%)
  bklnChange: number | null;   // BKLN 日變化(%)
  
  // 板塊B：流動性/壓力
  ofrFsi: number | null;       // OFR 金融壓力指數
  vix: number | null;          // VIX
  dxyChange: number | null;    // 美元指數日變化(%)
  
  // 板塊C：AI基建核心
  crwvChange: number | null;   // CRWV 日變化(%)
  nbisChange: number | null;   // NBIS 日變化(%)
  orclChange: number | null;   // ORCL 日變化(%)
  vrtChange: number | null;    // VRT 日變化(%)
  dlrChange: number | null;    // DLR 日變化(%)
  eqixChange: number | null;   // EQIX 日變化(%)
  
  // 板塊D：上游供應鏈
  nvdaChange: number | null;   // NVDA 日變化(%)
  amdChange: number | null;    // AMD 日變化(%)
  avgoChange: number | null;   // AVGO 日變化(%)
  tsmChange: number | null;    // TSM 日變化(%)
  
  // 板塊E：資金供給端
  arccChange: number | null;   // ARCC 日變化(%)
  bxslChange: number | null;   // BXSL 日變化(%)
  obdcChange: number | null;   // OBDC 日變化(%)
}

// ============================================================================
// 板塊分數
// ============================================================================

export interface SectorScore {
  score: number;        // 0-100 分數
  signal: SignalLevel; // 燈號
}

// ============================================================================
// 各板塊分數結構
// ============================================================================

export interface SectorScores {
  creditMarket: SectorScore;      // 信用市場（權重 35%）
  liquidityStress: SectorScore;   // 流動性/壓力（權重 25%）
  aiInfraCore: SectorScore;       // AI基建核心（權重 20%）
  chipSupplyChain: SectorScore;   // 上游供應鏈（權重 10%）
  privateCreditFunding: SectorScore; // 資金供給端（權重 10%）
}

// ============================================================================
// 系統性風險結果
// ============================================================================

export interface SystemicRiskResult {
  sectorScores: SectorScores;
  weightedTotal: number;          // 加權總分 (0-100)
  finalSignal: SignalLevel;       // 最終燈號
  triggeredRules: string[];       // 觸發的規則列表
}

// ============================================================================
// 單日資料記錄
// ============================================================================

export interface CreditMonitorRecord {
  日期: string;                    // YYYY-MM-DD
  季度: string;                    // 2026Q3
  sectorScores: SectorScores;
  weightedTotal: number;
  finalSignal: SignalLevel;
  triggeredRules: string[];
  rawInputs: SectorInputs;         // 原始輸入資料
}

// ============================================================================
// API 回傳資料結構
// ============================================================================

export interface CreditMonitorData {
  lastUpdated: string;             // ISO 時間字串
  quarters: string[];              // 所有可用季度列表
  latestQuarter: string;           // 最新季度
  data: CreditMonitorRecord[];     // 資料陣列
}

// ============================================================================
// FRED 資料系列 ID
// ============================================================================

export const FRED_SERIES = {
  // 板塊A：信用市場
  HY_OAS: 'BAMLH0A0HYM2',   // 高收益債利差 OAS
  IG_OAS: 'BAMLC0A0CM',     // 投資級債利差 OAS
  
  // 板塊B：流動性/壓力
  STL_FSI: 'STLFSI4',       // St. Louis Fed Financial Stress Index（週資料）
} as const;

// ============================================================================
// Yahoo Finance Ticker 列表
// ============================================================================

export const TICKERS = {
  // 板塊A：信用市場 ETF
  HYG: 'HYG',
  JNK: 'JNK',
  LQD: 'LQD',
  BKLN: 'BKLN',
  
  // 板塊B：流動性/壓力
  VIX: '^VIX',
  DXY: 'DX-Y.NYB',
  
  // 板塊C：AI基建核心
  CRWV: 'CRWV',
  NBIS: 'NBIS',
  ORCL: 'ORCL',
  VRT: 'VRT',
  DLR: 'DLR',
  EQIX: 'EQIX',
  
  // 板塊D：上游供應鏈
  NVDA: 'NVDA',
  AMD: 'AMD',
  AVGO: 'AVGO',
  TSM: 'TSM',
  
  // 板塊E：資金供給端
  ARCC: 'ARCC',
  BXSL: 'BXSL',
  OBDC: 'OBDC',
} as const;

// ============================================================================
// 創建空輸入（用於錯誤處理）
// ============================================================================

export function createEmptySectorInputs(): SectorInputs {
  return {
    hyOasDelta: null,
    igOasDelta: null,
    hygChange: null,
    jnkChange: null,
    lqdChange: null,
    bklnChange: null,
    ofrFsi: null,
    vix: null,
    dxyChange: null,
    crwvChange: null,
    nbisChange: null,
    orclChange: null,
    vrtChange: null,
    dlrChange: null,
    eqixChange: null,
    nvdaChange: null,
    amdChange: null,
    avgoChange: null,
    tsmChange: null,
    arccChange: null,
    bxslChange: null,
    obdcChange: null,
  };
}