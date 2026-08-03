/**
 * 日元 Carry Trade 平倉風險監控 - 前端類型定義
 */

// ============================================================================
// 風險等級
// ============================================================================

export type RiskLevel = '低' | '中' | '高';

// ============================================================================
// CFTC 投機性淨倉位
// ============================================================================

export interface CftcPosition {
  date: string;
  long: number;
  short: number;
  net: number;
}

// ============================================================================
// 風險評分
// ============================================================================

export interface RiskScore {
  usdjpySpeed: number;        // USD/JPY 速度分數 (0-40)
  vixLevel: number;           // VIX 水平分數 (0-30)
  cftcPositioning: number;    // CFTC 倉位擁擠度分數 (0-30)
  total: number;              // 總分 (0-100)
  level: RiskLevel;           // 風險等級
}

// ============================================================================
// API 回傳資料結構
// ============================================================================

export interface CarryTradeRiskData {
  // USD/JPY 報價與變化
  usdjpy: {
    price: number | null;       // 最新價格
    change2dPct: number | null; // 2 日漲跌幅 (%)
  } | null;
  
  // VIX 指數
  vix: number | null;
  
  // CFTC 投機性淨倉位
  cftc: {
    netNoncomm: number | null;  // 最新淨倉位
    history: CftcPosition[];    // 歷史資料（12週）
  } | null;
  
  // 風險評分
  score: RiskScore;
  
  // 最後更新時間
  lastUpdated: string;
}