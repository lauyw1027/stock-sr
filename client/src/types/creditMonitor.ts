/**
 * AI 基建系統性信用風險監控 - Client 端類型定義
 * 對應 Server 端的 creditMonitorTypes.ts
 */

// ============================================================================
// 信號等級
// ============================================================================

export type SignalLevel = '綠燈' | '黃燈' | '紅燈';

// ============================================================================
// 板塊輸入資料（僅用於 Debug/顯示原始資料）
// ============================================================================

export interface SectorInputs {
  hyOasDelta: number | null;
  igOasDelta: number | null;
  hygChange: number | null;
  jnkChange: number | null;
  lqdChange: number | null;
  bklnChange: number | null;
  ofrFsi: number | null;
  vix: number | null;
  dxyChange: number | null;
  crwvChange: number | null;
  nbisChange: number | null;
  orclChange: number | null;
  vrtChange: number | null;
  dlrChange: number | null;
  eqixChange: number | null;
  nvdaChange: number | null;
  amdChange: number | null;
  avgoChange: number | null;
  tsmChange: number | null;
  arccChange: number | null;
  bxslChange: number | null;
  obdcChange: number | null;
}

// ============================================================================
// 板塊分數
// ============================================================================

export interface SectorScore {
  score: number;
  signal: SignalLevel;
}

// ============================================================================
// 各板塊分數結構
// ============================================================================

export interface SectorScores {
  creditMarket: SectorScore;
  liquidityStress: SectorScore;
  aiInfraCore: SectorScore;
  chipSupplyChain: SectorScore;
  privateCreditFunding: SectorScore;
}

// ============================================================================
// 單日資料記錄
// ============================================================================

export interface CreditMonitorRecord {
  日期: string;
  季度: string;
  sectorScores: SectorScores;
  weightedTotal: number;
  finalSignal: SignalLevel;
  triggeredRules: string[];
  rawInputs: SectorInputs;
}

// ============================================================================
// API 回傳資料結構
// ============================================================================

export interface CreditMonitorData {
  lastUpdated: string;
  quarters: string[];
  latestQuarter: string;
  data: CreditMonitorRecord[];
}

// ============================================================================
// API Error 類型
// ============================================================================

export interface CreditMonitorError {
  error: string;
  message: string;
}

// ============================================================================
// Hook 回傳類型
// ============================================================================

export interface UseCreditMonitorResult {
  data: CreditMonitorData | null;
  filteredData: CreditMonitorRecord[];
  loading: boolean;
  error: CreditMonitorError | null;
  quarters: string[];
  activeQuarter: string;
  latest: CreditMonitorRecord | null;
  lastUpdated: string | null;
  setActiveQuarter: (quarter: string) => void;
  refetch: () => void;
}