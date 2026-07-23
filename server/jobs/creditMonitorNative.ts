/**
 * AI 基建系統性信用風險監控 - 資料抓取與排程模組
 * 使用 node-cron 每天固定時間自動抓取、計算並寫入結果
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import cron from 'node-cron';
import YahooFinancePkg from 'yahoo-finance2';
import { calculateSystemicRiskScore, getQuarterLabel } from '../utils/calculateSystemicRiskScore.js';
import {
  CreditMonitorData,
  CreditMonitorRecord,
  SectorInputs,
  FRED_SERIES,
  TICKERS,
  createEmptySectorInputs,
  type SignalLevel,
} from '../utils/creditMonitorTypes.js';

// 處理 ESM/CJS 兼容的 __dirname
let __dirname: string;
try {
  // 嘗試從 import.meta.url 取得（ESM 開發環境）
  __dirname = path.dirname(fileURLToPath(import.meta.url));
} catch {
  // 回退到使用 __filename 全域變數（CJS 生產環境）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __dirname = path.dirname((globalThis as any).__filename || __filename);
}

// Initialize YahooFinance
const YahooFinance: any = (YahooFinancePkg as any).default ?? YahooFinancePkg;
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

// 資料檔案路徑 - Vercel 的 /var/task 是唯讀，只有 /tmp 可寫入
// 本地開發則使用專案根目錄下的 data/ 資料夾
const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'credit_monitor.json');

// ============================================================================
// 工具函式
// ============================================================================

/**
 * 格式化日期為 YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 取得 N 天前的日期
 */
function getDaysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/**
 * 確保目錄存在
 */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ============================================================================
// FRED 資料抓取
// ============================================================================

/**
 * 從 FRED API 抓取資料系列
 * 需要 FRED_API_KEY 環境變數，免費申請：https://fred.stlouisfed.org/docs/api/api_key.html
 * @param seriesId - FRED 系列 ID
 * @param startDate - 開始日期
 * @param endDate - 結束日期
 * @returns Map<日期, 值>
 */
async function fetchFredSeries(seriesId: string, startDate: Date, endDate: Date): Promise<Map<string, number>> {
  const apiKey = process.env.FRED_API_KEY;
  
  if (!apiKey) {
    console.warn(`[FRED] No API key configured for ${seriesId}, skipping...`);
    return new Map();
  }
  
  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&observation_start=${startStr}&observation_end=${endStr}&file_type=json`;
  
  try {
    const response = await axios.get(url, { timeout: 30000 });
    const observations = response.data.observations as Array<{ date: string; value: string }>;
    
    const result = new Map<string, number>();
    for (const obs of observations) {
      if (obs.value !== '.' && !isNaN(parseFloat(obs.value))) {
        result.set(obs.date, parseFloat(obs.value));
      }
    }
    
    console.log(`[FRED] ${seriesId}: fetched ${result.size} records`);
    return result;
  } catch (error) {
    console.error(`[FRED] Error fetching ${seriesId}:`, error);
    return new Map();
  }
}

// ============================================================================
// Yahoo Finance 資料抓取
// ============================================================================

/**
 * 從 Yahoo Finance 抓取歷史收盤價並計算日變化百分比
 * @param ticker - 股票代碼
 * @param days - 抓取天數
 * @returns 最新日變化百分比
 */
async function fetchStockChange(ticker: string, days: number = 5): Promise<number | null> {
  try {
    const endDate = new Date();
    const startDate = getDaysAgo(days);
    
    const chart = await yahooFinance.chart(ticker, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });
    
    const hist = chart?.quotes ?? [];
    if (hist.length < 2) {
      console.warn(`[Yahoo] ${ticker}: insufficient data (${hist.length} records)`);
      return null;
    }
    
    // 按日期排序
    hist.sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime());
    
    // 取得最近兩天的收盤價
    const latest = hist[hist.length - 1];
    const previous = hist[hist.length - 2];
    
    if (!latest?.close || !previous?.close) {
      console.warn(`[Yahoo] ${ticker}: missing close price`);
      return null;
    }
    
    // 計算日變化百分比
    const change = ((latest.close - previous.close) / previous.close) * 100;
    return Math.round(change * 100) / 100; // 保留兩位小數
    
  } catch (error) {
    console.error(`[Yahoo] Error fetching ${ticker}:`, error);
    return null;
  }
}

/**
 * 批量抓取多個股票/ETF的日變化
 */
async function fetchMultipleStockChanges(
  tickers: Record<string, string>
): Promise<Record<string, number | null>> {
  const results: Record<string, number | null> = {};
  
  // 並行抓取所有 ticker
  const entries = Object.entries(tickers);
  const promises = entries.map(async ([key, ticker]) => {
    const change = await fetchStockChange(ticker);
    return { key, change };
  });
  
  const batchResults = await Promise.allSettled(promises);
  
  for (const result of batchResults) {
    if (result.status === 'fulfilled') {
      results[result.value.key] = result.value.change;
    } else {
      console.error(`[StockChange] Error:`, result.reason);
      results[result.key] = null;
    }
  }
  
  return results;
}

// ============================================================================
// 資料合併與計算
// ============================================================================

/**
 * 抓取並計算當日所有指標
 */
async function collectDailyInputs(): Promise<SectorInputs> {
  const inputs = createEmptySectorInputs();
  const today = new Date();
  const twoDaysAgo = getDaysAgo(2);
  
  console.log('[CreditMonitor] Starting data collection...');
  
  // -------------------------------------------------------------------------
  // 1. 抓取 FRED 資料（信用市場利差、流動性壓力指數）
  // -------------------------------------------------------------------------
  console.log('[CreditMonitor] Fetching FRED data...');
  
  // 抓取高收益債利差（抓取更多天數確保有資料）
  const hyOasData = await fetchFredSeries(FRED_SERIES.HY_OAS, getDaysAgo(14), today);
  const hyOasDates = Array.from(hyOasData.keys()).sort();
  console.log(`[CreditMonitor] BAMLH0A0HYM2 dates: ${hyOasDates.join(', ')}`);
  if (hyOasDates.length >= 2) {
    // 使用最後兩個可用日期計算變化（而非假設今天有資料）
    const latestDate = hyOasDates[hyOasDates.length - 1];
    const prevDate = hyOasDates[hyOasDates.length - 2];
    const latestVal = hyOasData.get(latestDate);
    const prevVal = hyOasData.get(prevDate);
    if (latestVal !== undefined && prevVal !== undefined) {
      inputs.hyOasDelta = Math.round((latestVal - prevVal) * 1000) / 1000;
      console.log(`[CreditMonitor] HY OAS: ${prevDate}=${prevVal} -> ${latestDate}=${latestVal}, delta=${inputs.hyOasDelta}`);
    }
  }
  
  // 抓取投資級債利差
  const igOasData = await fetchFredSeries(FRED_SERIES.IG_OAS, getDaysAgo(14), today);
  const igOasDates = Array.from(igOasData.keys()).sort();
  console.log(`[CreditMonitor] BAMLC0A0CM dates: ${igOasDates.join(', ')}`);
  if (igOasDates.length >= 2) {
    const latestDate = igOasDates[igOasDates.length - 1];
    const prevDate = igOasDates[igOasDates.length - 2];
    const latestVal = igOasData.get(latestDate);
    const prevVal = igOasData.get(prevDate);
    if (latestVal !== undefined && prevVal !== undefined) {
      inputs.igOasDelta = Math.round((latestVal - prevVal) * 1000) / 1000;
      console.log(`[CreditMonitor] IG OAS: ${prevDate}=${prevVal} -> ${latestDate}=${latestVal}, delta=${inputs.igOasDelta}`);
    }
  }
  
  // 抓取 STL 金融壓力指數（取最新值）
  const stlFsiData = await fetchFredSeries(FRED_SERIES.STL_FSI, getDaysAgo(14), today);
  const stlFsiDates = Array.from(stlFsiData.keys()).sort();
  if (stlFsiDates.length > 0) {
    inputs.ofrFsi = stlFsiData.get(stlFsiDates[stlFsiDates.length - 1]) ?? null;
    console.log(`[CreditMonitor] STLFSI4: ${inputs.ofrFsi}`);
  }
  
  // -------------------------------------------------------------------------
  // 2. 抓取股票/ETF 日變化
  // -------------------------------------------------------------------------
  console.log('[CreditMonitor] Fetching stock/ETF changes...');
  
  const stockChanges = await fetchMultipleStockChanges({
    // 板塊A：信用市場 ETF
    hygChange: TICKERS.HYG,
    jnkChange: TICKERS.JNK,
    lqdChange: TICKERS.LQD,
    bklnChange: TICKERS.BKLN,
    
    // 板塊B：流動性/壓力
    vix: TICKERS.VIX,
    dxyChange: TICKERS.DXY,
    
    // 板塊C：AI基建核心
    crwvChange: TICKERS.CRWV,
    nbisChange: TICKERS.NBIS,
    orclChange: TICKERS.ORCL,
    vrtChange: TICKERS.VRT,
    dlrChange: TICKERS.DLR,
    eqixChange: TICKERS.EQIX,
    
    // 板塊D：上游供應鏈
    nvdaChange: TICKERS.NVDA,
    amdChange: TICKERS.AMD,
    avgoChange: TICKERS.AVGO,
    tsmChange: TICKERS.TSM,
    
    // 板塊E：資金供給端
    arccChange: TICKERS.ARCC,
    bxslChange: TICKERS.BXSL,
    obdcChange: TICKERS.OBDC,
  });
  
  // VIX 需要取最新收盤價（直接從 quote API 取得，不是日變化）
  try {
    const vixQuote = await yahooFinance.quote(TICKERS.VIX);
    if (vixQuote?.regularMarketPrice) {
      inputs.vix = vixQuote.regularMarketPrice;
      console.log(`[CreditMonitor] VIX: ${inputs.vix}`);
    }
  } catch (e) {
    console.error('[CreditMonitor] Error fetching VIX:', e);
  }
  
  // 複製其他股票變化（排除 vix，因為我們已經單獨處理）
  const { vix: _vix, ...otherChanges } = stockChanges;
  Object.assign(inputs, otherChanges);
  
  console.log('[CreditMonitor] Data collection complete');
  
  return inputs;
}

// ============================================================================
// 資料儲存
// ============================================================================

/**
 * 讀取現有資料
 */
function loadExistingData(): CreditMonitorData {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(content) as CreditMonitorData;
    }
    // 在 Vercel 上，/tmp 在冷啟動後為空白。嘗試讀取專案內建的種子資料
    if (process.env.VERCEL) {
      const seedFile = path.join(process.cwd(), 'data', 'credit_monitor.json');
      if (fs.existsSync(seedFile)) {
        const content = fs.readFileSync(seedFile, 'utf-8');
        console.log('[CreditMonitor] Loaded seed data from bundled file');
        return JSON.parse(content) as CreditMonitorData;
      }
    }
  } catch (error) {
    console.error('[CreditMonitor] Error loading existing data:', error);
  }
  
  return {
    lastUpdated: '',
    quarters: [],
    latestQuarter: '',
    data: [],
  };
}

/**
 * 儲存資料
 */
function saveData(data: CreditMonitorData): void {
  try {
    ensureDir(path.dirname(DATA_FILE));
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[CreditMonitor] Data saved to ${DATA_FILE}`);
  } catch (error) {
    console.error('[CreditMonitor] Error saving data:', error);
    throw error;
  }
}

/**
 * 合併新資料（避免重複日期）
 */
function mergeData(existingData: CreditMonitorData, newRecord: CreditMonitorRecord): CreditMonitorData {
  // 檢查是否已存在該日期的資料
  const existingIndex = existingData.data.findIndex(r => r.日期 === newRecord.日期);
  
  if (existingIndex >= 0) {
    // 更新現有記錄
    existingData.data[existingIndex] = newRecord;
  } else {
    // 新增記錄
    existingData.data.push(newRecord);
  }
  
  // 按日期排序
  existingData.data.sort((a, b) => new Date(a.日期).getTime() - new Date(b.日期).getTime());
  
  // 更新季度列表
  const quartersSet = new Set<string>();
  for (const record of existingData.data) {
    quartersSet.add(record.季度);
  }
  existingData.quarters = Array.from(quartersSet).sort();
  
  // 更新最新季度
  if (existingData.quarters.length > 0) {
    existingData.latestQuarter = existingData.quarters[existingData.quarters.length - 1];
  }
  
  // 更新最後更新時間
  existingData.lastUpdated = new Date().toISOString();
  
  return existingData;
}

// ============================================================================
// 主執行函式
// ============================================================================

/**
 * 執行每日資料更新
 */
export async function runCreditMonitorJob(): Promise<CreditMonitorRecord | null> {
  console.log('[CreditMonitor] Running daily job...');
  
  try {
    // 1. 收集當日資料
    const inputs = await collectDailyInputs();
    
    // 2. 計算風險分數
    const result = calculateSystemicRiskScore(inputs);
    
    // 3. 建立記錄
    const today = formatDate(new Date());
    const record: CreditMonitorRecord = {
      日期: today,
      季度: getQuarterLabel(today),
      sectorScores: result.sectorScores,
      weightedTotal: result.weightedTotal,
      finalSignal: result.finalSignal,
      triggeredRules: result.triggeredRules,
      rawInputs: inputs,
    };
    
    console.log(`[CreditMonitor] Today: ${today}, Signal: ${result.finalSignal}, Score: ${result.weightedTotal}`);
    if (result.triggeredRules.length > 0) {
      console.log('[CreditMonitor] Triggered rules:', result.triggeredRules);
    }
    
    // 4. 合併並儲存
    const existingData = loadExistingData();
    const mergedData = mergeData(existingData, record);
    saveData(mergedData);
    
    return record;
  } catch (error) {
    console.error('[CreditMonitor] Job failed:', error);
    return null;
  }
}

// ============================================================================
// 歷史回填功能
// ============================================================================

/**
 * 回填歷史資料（用於初始化或補齊遺漏的日期）
 * @param startDate 開始日期
 * @param endDate 結束日期
 */
export async function backfillHistory(startDate: string, endDate: string): Promise<number> {
  console.log(`[CreditMonitor] Backfilling from ${startDate} to ${endDate}...`);
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  let filled = 0;
  
  // 逐一日期處理
  const current = new Date(start);
  while (current <= end) {
    const dateStr = formatDate(current);
    
    // 略過週末（週六週日）
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      try {
        // 收集該日期的資料（需要模擬歷史時間點）
        const inputs = await collectDailyInputsForDate(current);
        
        // 計算風險分數
        const result = calculateSystemicRiskScore(inputs);
        
        // 建立記錄
        const record: CreditMonitorRecord = {
          日期: dateStr,
          季度: getQuarterLabel(dateStr),
          sectorScores: result.sectorScores,
          weightedTotal: result.weightedTotal,
          finalSignal: result.finalSignal,
          triggeredRules: result.triggeredRules,
          rawInputs: inputs,
        };
        
        // 合併並儲存
        const existingData = loadExistingData();
        const mergedData = mergeData(existingData, record);
        saveData(mergedData);
        
        console.log(`[CreditMonitor] ${dateStr}: ${result.finalSignal} (score: ${result.weightedTotal})`);
        filled++;
      } catch (e) {
        console.error(`[CreditMonitor] Error processing ${dateStr}:`, e);
      }
    }
    
    // 前進一天
    current.setDate(current.getDate() + 1);
  }
  
  console.log(`[CreditMonitor] Backfill complete: ${filled} days processed`);
  return filled;
}

/**
 * 為特定日期收集資料（內部使用）
 */
async function collectDailyInputsForDate(targetDate: Date): Promise<SectorInputs> {
  const inputs = createEmptySectorInputs();
  
  // FRED 資料需要抓取到該日期為止的歷史資料
  const fetchFredForDate = async (seriesId: string, daysBack: number): Promise<Map<string, number>> => {
    const endDate = new Date(targetDate);
    const startDate = new Date(targetDate);
    startDate.setDate(startDate.getDate() - daysBack);
    return fetchFredSeries(seriesId, startDate, endDate);
  };
  
  // 抓取 FRED 資料
  const hyOasData = await fetchFredForDate(FRED_SERIES.HY_OAS, 5);
  const hyOasDates = Array.from(hyOasData.keys()).sort();
  if (hyOasDates.length >= 2) {
    const latestVal = hyOasData.get(hyOasDates[hyOasDates.length - 1]);
    const prevVal = hyOasData.get(hyOasDates[hyOasDates.length - 2]);
    if (latestVal !== undefined && prevVal !== undefined) {
      inputs.hyOasDelta = Math.round((latestVal - prevVal) * 1000) / 1000;
    }
  }
  
  const igOasData = await fetchFredForDate(FRED_SERIES.IG_OAS, 5);
  const igOasDates = Array.from(igOasData.keys()).sort();
  if (igOasDates.length >= 2) {
    const latestVal = igOasData.get(igOasDates[igOasDates.length - 1]);
    const prevVal = igOasData.get(igOasDates[igOasDates.length - 2]);
    if (latestVal !== undefined && prevVal !== undefined) {
      inputs.igOasDelta = Math.round((latestVal - prevVal) * 1000) / 1000;
    }
  }
  
  const stlFsiData = await fetchFredForDate(FRED_SERIES.STL_FSI, 14);
  const stlFsiDates = Array.from(stlFsiData.keys()).sort();
  if (stlFsiDates.length > 0) {
    inputs.ofrFsi = stlFsiData.get(stlFsiDates[stlFsiDates.length - 1]) ?? null;
  }
  
  // 股票資料需要用歷史日期抓取（使用 Yahoo Finance 的 period1/period2）
  // 這裡簡化處理 - 實際應該用歷史日期範圍
  // TODO: 完整實現需要為每個歷史日期調用 Yahoo Finance
  
  console.log(`[CreditMonitor] Historical inputs for ${formatDate(targetDate)}: HY=${inputs.hyOasDelta}, IG=${inputs.igOasDelta}, STLFSI=${inputs.ofrFsi}`);
  
  return inputs;
}

// ============================================================================
// 排程管理
// ============================================================================

let cronJob: cron.ScheduledTask | null = null;

/**
 * 啟動排程任務
 * @param cronExpression - cron 表達式（預設每天 UTC 06:00）
 */
export function startCronJob(cronExpression: string = '0 6 * * *'): void {
  if (cronJob) {
    console.log('[CreditMonitor] Cron job already running');
    return;
  }
  
  try {
    console.log(`[CreditMonitor] Starting cron job: ${cronExpression} (UTC)`);
    
    cronJob = cron.schedule(cronExpression, async () => {
      console.log('[CreditMonitor] Cron triggered');
      await runCreditMonitorJob();
    });
    
    console.log('[CreditMonitor] Cron job started');
  } catch (error) {
    console.error('[CreditMonitor] Failed to start cron job:', error);
  }
}

/**
 * 停止排程任務
 */
export function stopCronJob(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[CreditMonitor] Cron job stopped');
  }
}

/**
 * 取得資料（供 API 使用）
 */
export function getCreditMonitorData(): CreditMonitorData {
  return loadExistingData();
}

/**
 * 取得指定季度的資料
 */
export function getCreditMonitorDataByQuarter(quarter: string): CreditMonitorData {
  const data = loadExistingData();
  
  const filteredData = data.data.filter(r => r.季度 === quarter);
  
  return {
    ...data,
    data: filteredData,
  };
}

/**
 * 手動觸發更新（用於測試或立即執行）
 */
export async function triggerManualUpdate(): Promise<CreditMonitorRecord | null> {
  return runCreditMonitorJob();
}