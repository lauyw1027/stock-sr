import YahooFinancePkg from "yahoo-finance2";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import * as cheerio from "cheerio";

// Prefer the deployed data directory when it exists, otherwise fall back to /tmp.
// This keeps Vercel using the same cache files that ship with the deployment.
const DATA_DIR = (() => {
  const localDataDir = path.resolve(process.cwd(), "data");
  if (fs.existsSync(localDataDir)) {
    return localDataDir;
  }
  return "/tmp";
})();

// Initialize YahooFinance (same as in routes.ts)
const YahooFinance: any = (YahooFinancePkg as any).default ?? YahooFinancePkg;
export const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

// Helper function to format date as YYYY-MM-DD in local timezone (避免 toISOString UTC 轉換問題)
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Earnings date cache - 8 hours TTL
interface EarningsCacheEntry {
  date: string | null;
  daysUntil: number | null;
  cachedAt: number;
}
const earningsCache: Map<string, EarningsCacheEntry> = new Map();
const EARNINGS_CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * Get next earnings date for a symbol with caching
 */
async function getNextEarningsDate(symbol: string): Promise<{ date: string | null; daysUntil: number | null }> {
  const now = Date.now();
  
  // Check cache first
  const cached = earningsCache.get(symbol);
  if (cached && (now - cached.cachedAt) < EARNINGS_CACHE_TTL_MS) {
    return { date: cached.date, daysUntil: cached.daysUntil };
  }

  try {
    const result = await yahooFinance.quoteSummary(symbol, { modules: ["calendarEvents"] });
    const earningsDates = result?.calendarEvents?.earnings?.earningsDate;

    if (!earningsDates || earningsDates.length === 0) {
      // Cache negative result too
      earningsCache.set(symbol, { date: null, daysUntil: null, cachedAt: now });
      return { date: null, daysUntil: null };
    }

    const nextDate = new Date(earningsDates[0]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffMs = nextDate.getTime() - today.getTime();
    const daysUntil = Math.round(diffMs / (1000 * 60 * 60 * 24));

    const earningsResult = {
      date: formatDate(nextDate),
      daysUntil: daysUntil >= 0 ? daysUntil : null,
    };

    // Cache the result
    earningsCache.set(symbol, { ...earningsResult, cachedAt: now });
    return earningsResult;
  } catch (e) {
    console.error(`[Earnings] Error fetching earnings date for ${symbol}:`, e);
    // Cache negative result on error too
    earningsCache.set(symbol, { date: null, daysUntil: null, cachedAt: now });
    return { date: null, daysUntil: null };
  }
}

export type Exchange = "NYSE" | "NASDAQ" | "AMEX";

export interface StockInfo {
  symbol: string;
  exchange: Exchange;
  companyName: string;
}

export type SectorCategory =
  | "mature_stable"
  | "cyclical"
  | "asset_heavy"
  | "growth_consumer"
  | "growth_software"
  | "early_stage_loss"
  | "unclassified";

export interface ATHATLRecord {
  symbol: string;
  company_name: string;
  exchange: string;
  industry: string;  // Original field for backward compatibility
  last_close: number;
  ath_price: number | null;
  ath_date: string | null;
  atl_price: number | null;
  atl_date: string | null;
  change_pct: number;
  volume: number;
  list_type: "ATH" | "ATL" | "52W_ATH" | "52W_ATL";
  next_earnings_date: string | null;
  days_to_earnings: number | null;
  // Valuation fields
  forwardPE: number | null;
  pegNearTerm: number | null;
  pegLongTerm: number | null;
  nearTermGrowthPct: number | null;
  longTermGrowthPct: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  peBookHistoricalPercentile: number | null;
  dividendYield: number | null;
  sectorCategory: SectorCategory;
  primaryValuationMetric: string;
  isProfitable: boolean | null;
  sector: string | null;      // GICS Sector 原始名稱，例如 "Consumer Cyclical"
  gicsIndustry: string | null; // GICS Industry 原始名稱，例如 "Household & Personal Products"
  // Peer comparison fields
  peerAvgForwardPE: number | null;
  peerCount: number;
}

// ============ Sector Classification Functions ============

function classifySectorCategory(sector: string | undefined, industry: string | undefined, isProfitable: boolean | null): SectorCategory {
  const s = (sector ?? "").toLowerCase();
  const i = (industry ?? "").toLowerCase();

  if (isProfitable === false) return "early_stage_loss";

  if (i.includes("reit") || i.includes("real estate")) return "asset_heavy";

  if (s.includes("energy") || i.includes("steel") || i.includes("chemical") || i.includes("materials")) return "cyclical";

  if (s.includes("financial") || s.includes("utilities") || i.includes("telecom")) return "mature_stable";

  if (s.includes("technology") && (i.includes("software") || i.includes("internet") || i.includes("saas"))) return "growth_software";

  if (s.includes("consumer") && isProfitable) return "growth_consumer";

  // 新增規則:Industrials(工業股)
  if (s.includes("industrial")) {
    // 工業股裡的機械/設備/航太國防類，成熟現金流公司，適合用Forward P/E + PEG
    // 沒有更細的次分類需求，統一歸為成熟穩定型的估值邏輯（Forward P/E為主，PEG次要參考）
    return "mature_stable";
  }

  // 新增規則:Healthcare(醫療保健,非虧損型)
  if (s.includes("healthcare")) {
    if (i.includes("biotechnology") || i.includes("drug manufacturers")) {
      // 生技/製藥類，盈餘品質受研發週期、專利懸崖影響大，PEG參考性較低，優先看P/S與P/B
      return "cyclical";
    }
    // 醫療設備、醫療保健計劃、醫療照護設施等，較穩定的現金流業務
    return "growth_consumer";
  }

  return "unclassified";
}

function getPrimaryMetricLabel(category: SectorCategory): string {
  const map: Record<SectorCategory, string> = {
    mature_stable: "Forward P/E, P/B, 股息率",
    cyclical: "P/B歷史分位（PEG參考性低）",
    asset_heavy: "P/B, 股息率（PEG不適用）",
    growth_consumer: "Forward P/E + PEG",
    growth_software: "P/S（EV/Sales等進階指標Phase 2實作，PEG常失真）",
    early_stage_loss: "P/S（PEG不適用）",
    unclassified: "Forward P/E + PEG（預設）",
  };
  return map[category];
}

// ============ Valuation Metrics Functions ============

interface ValuationData {
  forwardPE: number | null;
  pegNearTerm: number | null;
  pegLongTerm: number | null;
  nearTermGrowthPct: number | null;
  longTermGrowthPct: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  peBookHistoricalPercentile: number | null;
  dividendYield: number | null;
  sectorCategory: SectorCategory;
  primaryValuationMetric: string;
  isProfitable: boolean | null;
  sector: string | null;
  industry: string | null;
  // Peer comparison fields
  peerAvgForwardPE: number | null;
  peerCount: number;
}

const valuationCache = new Map<string, { data: ValuationData; cachedAt: number }>();
const VALUATION_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Get valuation metrics for a symbol with 12-hour caching
 */
async function getValuationMetrics(
  symbol: string,
  options: { includePeerData?: boolean } = {}
): Promise<ValuationData> {
  const now = Date.now();
  const includePeerData = options.includePeerData ?? false;
  const cached = valuationCache.get(symbol);

  const cacheValid = cached && (now - cached.cachedAt) < VALUATION_CACHE_TTL_MS;
  const cachedHasPeerData = cached && (cached.data.peerAvgForwardPE !== null || cached.data.peerCount > 0);

  // If cache is valid and we don't need peer data, or cache already has peer data
  if (cacheValid && (!includePeerData || cachedHasPeerData)) {
    return cached.data;
  }

  // If basic valuation is cached but we need peer data and it's missing, only fetch peer
  if (cacheValid && includePeerData && !cachedHasPeerData) {
    const peerPEResult = await getPeerAvgForwardPE(symbol);
    const enrichedData: ValuationData = {
      ...cached.data,
      peerAvgForwardPE: peerPEResult.peerAvgForwardPE,
      peerCount: peerPEResult.peerCount,
    };
    valuationCache.set(symbol, { data: enrichedData, cachedAt: now });
    return enrichedData;
  }

  // No valid cache, fetch everything
  try {
    // Fetch valuation data (and peer data if needed)
    const stats = await yahooFinance.quoteSummary(symbol, {
      modules: ["defaultKeyStatistics", "summaryDetail", "financialData", "earningsTrend", "assetProfile"],
    });

    const peerPEResult = includePeerData
      ? await getPeerAvgForwardPE(symbol)
      : { peerAvgForwardPE: null, peerCount: 0 };

    const currentPrice = stats.financialData?.currentPrice ?? stats.summaryDetail?.previousClose ?? null;
    const forwardEps = stats.defaultKeyStatistics?.forwardEps ?? null;
    const forwardPE = (currentPrice && forwardEps && forwardEps > 0) ? currentPrice / forwardEps : null;

    const trendData = stats.earningsTrend?.trend ?? [];
    const nearTermTrend = trendData.find((t: any) => t.period === "+1y");
    const longTermTrend = trendData.find((t: any) => t.period === "+5y");

    const nearTermGrowthPct = nearTermTrend?.growth ? nearTermTrend.growth * 100 : null;
    const longTermGrowthPct = longTermTrend?.growth ? longTermTrend.growth * 100 : null;

    const pegNearTerm = (forwardPE && nearTermGrowthPct && nearTermGrowthPct > 0) ? forwardPE / nearTermGrowthPct : null;
    const pegLongTerm = (forwardPE && longTermGrowthPct && longTermGrowthPct > 0) ? forwardPE / longTermGrowthPct : null;

    const priceToSales = stats.summaryDetail?.priceToSalesTrailing12Months ?? null;
    const priceToBook = stats.defaultKeyStatistics?.priceToBook ?? null;
    const dividendYield = stats.summaryDetail?.dividendYield ?? null;
    const netIncomeToCommon = stats.defaultKeyStatistics?.netIncomeToCommon ?? null;
    const isProfitable = netIncomeToCommon !== null ? netIncomeToCommon > 0 : null;

    const sector = stats.assetProfile?.sector ?? null;
    const industry = stats.assetProfile?.industry ?? null;

    const sectorCategory = classifySectorCategory(sector ?? undefined, industry ?? undefined, isProfitable);
    const primaryValuationMetric = getPrimaryMetricLabel(sectorCategory);

    let peBookHistoricalPercentile: number | null = null;

    if (sectorCategory === "cyclical" || sectorCategory === "asset_heavy") {
      peBookHistoricalPercentile = await calculatePBHistoricalPercentile(symbol, priceToBook);
    }

    const result: ValuationData = {
      forwardPE, pegNearTerm, pegLongTerm, nearTermGrowthPct, longTermGrowthPct,
      priceToSales, priceToBook, peBookHistoricalPercentile, dividendYield,
      sectorCategory, primaryValuationMetric, isProfitable, sector, industry,
      peerAvgForwardPE: peerPEResult.peerAvgForwardPE,
      peerCount: peerPEResult.peerCount,
    };

    valuationCache.set(symbol, { data: result, cachedAt: now });
    return result;

  } catch (e) {
    console.error(`[Valuation] Error fetching valuation for ${symbol}:`, e);
    const nullResult: ValuationData = {
      forwardPE: null, pegNearTerm: null, pegLongTerm: null, nearTermGrowthPct: null, longTermGrowthPct: null,
      priceToSales: null, priceToBook: null, peBookHistoricalPercentile: null, dividendYield: null,
      sectorCategory: "unclassified", primaryValuationMetric: getPrimaryMetricLabel("unclassified"), isProfitable: null,
      sector: null, industry: null,
      peerAvgForwardPE: null,
      peerCount: 0,
    };
    valuationCache.set(symbol, { data: nullResult, cachedAt: now });
    return nullResult;
  }
}

/**
 * Calculate P/B historical percentile using 3-year price data
 * This is an approximation method - calculates implied book value from current P/B
 * and compares historical price-derived P/B values
 */
async function calculatePBHistoricalPercentile(symbol: string, currentPB: number | null): Promise<number | null> {
  if (!currentPB) return null;

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 3);

    const chart = await yahooFinance.chart(symbol, { period1: startDate, period2: endDate, interval: "1mo" });
    const quotes = chart?.quotes ?? [];

    if (quotes.length < 12) return null;

    const currentPrice = quotes[quotes.length - 1]?.close;
    if (!currentPrice) return null;

    const impliedBookValue = currentPrice / currentPB;
    if (!impliedBookValue || impliedBookValue <= 0) return null;

    const historicalPBs = quotes
      .map((q: any) => q.close / impliedBookValue)
      .filter((pb: number) => isFinite(pb) && pb > 0);

    if (historicalPBs.length < 12) return null;

    const sorted = [...historicalPBs].sort((a, b) => a - b);
    let rank = 0;
    for (const pb of sorted) {
      if (currentPB > pb) rank++;
    }

    return Math.round((rank / sorted.length) * 100);
  } catch (e) {
    console.error(`[Valuation] Error calculating PB percentile for ${symbol}:`, e);
    return null;
  }
}

// ============ Peer Comparison Functions ============

interface PeerCacheEntry {
  peers: string[];
  cachedAt: number;
}

interface PeerSymbolsResult {
  peers: string[];
  fetched: boolean; // true if FMP returned a valid response (success or empty), false if failed
}

const peerListCache = new Map<string, PeerCacheEntry>();
const PEER_LIST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (同業關係變動很慢)

/**
 * Extract peer symbols from FMP stable endpoint response
 * Supports the new format: [{ symbol, companyName, price, mktCap }, ...]
 */
function extractPeerSymbols(data: unknown): { peers: string[]; recognized: boolean } {
  const maxPeers = 8;

  const normalizeSymbols = (values: unknown[]): string[] => {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        const normalized = value.trim().toUpperCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          unique.push(normalized);
        }
      }
    }
    return unique.slice(0, maxPeers);
  };

  // Format A: New stable endpoint - direct array of peer company objects
  // [{ symbol: "PFGC", companyName: "...", price: ..., mktCap: ... }, ...]
  if (Array.isArray(data)) {
    if (data.length === 0) {
      // Empty array = valid response with no peers
      return { peers: [], recognized: true };
    }

    // Extract symbol from each object in the array
    const objectSymbols = data
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item)
      )
      .map((item) => item.symbol)
      .filter((symbol): symbol is string => typeof symbol === "string");

    if (objectSymbols.length > 0) {
      return {
        peers: normalizeSymbols(objectSymbols),
        recognized: true,
      };
    }

    // Format B: Direct array of ticker strings - ["PFGC", "SYY", ...]
    if (data.every((item) => typeof item === "string")) {
      return {
        peers: normalizeSymbols(data),
        recognized: true,
      };
    }

    // Format C: Old wrapped format - [{ symbol: "USFD", peersList: [...] }]
    const firstItem = data[0] as Record<string, unknown>;
    if (firstItem && typeof firstItem === "object" && !Array.isArray(firstItem)) {
      if (Array.isArray(firstItem.peersList)) {
        return {
          peers: normalizeSymbols(firstItem.peersList),
          recognized: true,
        };
      }
      if (Array.isArray(firstItem.peers)) {
        return {
          peers: normalizeSymbols(firstItem.peers),
          recognized: true,
        };
      }
    }

    return { peers: [], recognized: false };
  }

  // Format D: Non-array object with peersList/peers
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.peersList)) {
      return {
        peers: normalizeSymbols(obj.peersList),
        recognized: true,
      };
    }
    if (Array.isArray(obj.peers)) {
      return {
        peers: normalizeSymbols(obj.peers),
        recognized: true,
      };
    }
  }

  return { peers: [], recognized: false };
}

/**
 * Get peer symbols from FMP Stock Peers API with 30-day caching
 * Only caches successful responses; failed requests are not cached
 */
async function getPeerSymbols(symbol: string): Promise<PeerSymbolsResult> {
  const now = Date.now();
  const cached = peerListCache.get(symbol);

  if (cached && (now - cached.cachedAt) < PEER_LIST_CACHE_TTL_MS) {
    return { peers: cached.peers, fetched: true };
  }

  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    console.warn(`[Peers] FMP_API_KEY is not configured; skipping ${symbol}`);
    return { peers: [], fetched: false };
  }

  try {
    const encodedSymbol = encodeURIComponent(symbol);
    const url = `https://financialmodelingprep.com/stable/stock-peers?symbol=${encodedSymbol}&apikey=${apiKey}`;

    const res = await axios.get(url, { timeout: 15000 });
    const parsed = extractPeerSymbols(res.data);

    if (!parsed.recognized) {
      console.error(`[Peers] Unrecognized stable FMP payload for ${symbol}`, {
        isArray: Array.isArray(res.data),
        firstItemKeys: Array.isArray(res.data) && res.data[0] && typeof res.data[0] === "object"
          ? Object.keys(res.data[0] as object).slice(0, 20)
          : [],
      });
      // Unrecognized format - don't cache, allow retry
      return { peers: [], fetched: false };
    }

    // Filter out the symbol itself (safety check)
    const peers = parsed.peers.filter(
      (peerSymbol) => peerSymbol.toUpperCase() !== symbol.toUpperCase()
    );

    console.log(`[Peers] Parsed stable peers for ${symbol}`, {
      peerCount: peers.length,
      peers,
    });

    // Only cache recognized valid formats (including "recognized but actually no peers")
    peerListCache.set(symbol, { peers, cachedAt: now });
    return { peers, fetched: true };
  } catch (e: any) {
    const status = e?.response?.status;
    // Log safe info only - don't expose URL with API key
    console.error(`[Peers] Failed to fetch stable peers for ${symbol}`, {
      status: status ?? "no-http-status",
      code: e?.code ?? "unknown",
      message: e?.message ?? "unknown error",
    });
    // Don't cache failed requests - allow retry on next scan
    return { peers: [], fetched: false };
  }
}

/**
 * Get Forward P/E only for a symbol (lightweight function)
 */

/**
 * Get cached Forward P/E from existing valuation cache (if available)
 * Returns undefined if no cache entry exists (needs fallback to Yahoo Finance)
 * Returns null if cache exists but Forward PE is null (known failure, no need to retry)
 * Returns number if cache has valid Forward PE
 */
function getCachedForwardPE(symbol: string): number | null | undefined {
  const cached = valuationCache.get(symbol);
  if (!cached) return undefined;
  return cached.data.forwardPE;
}

async function getForwardPEOnly(symbol: string): Promise<number | null> {
  try {
    const stats = await yahooFinance.quoteSummary(symbol, {
      modules: ["defaultKeyStatistics", "financialData", "summaryDetail"],
    });

    const currentPrice = stats.financialData?.currentPrice ?? stats.summaryDetail?.previousClose ?? null;
    const forwardEps = stats.defaultKeyStatistics?.forwardEps ?? null;

    if (currentPrice && forwardEps && forwardEps > 0) {
      return currentPrice / forwardEps;
    }

    return null;
  } catch (e) {
    return null;
  }
}

interface PeerPECacheEntry {
  peerAvgForwardPE: number | null;
  peerCount: number;
  cachedAt: number;
}

const peerAvgPECache = new Map<string, PeerPECacheEntry>();
const PEER_PE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Clear all peer-related caches (for manual use when FMP quota resets)
 * Call this after FMP quota resets to allow retrying failed requests
 */
export function clearPeerCaches(): void {
  peerListCache.clear();
  peerAvgPECache.clear();
  console.log("[Peers] Peer caches cleared");
}

/**
 * Get peer average Forward P/E with 24-hour caching
 * Returns median of valid peer Forward P/E values
 */
async function getPeerAvgForwardPE(symbol: string): Promise<{ peerAvgForwardPE: number | null; peerCount: number }> {
  const now = Date.now();
  const cached = peerAvgPECache.get(symbol);

  if (cached && (now - cached.cachedAt) < PEER_PE_CACHE_TTL_MS) {
    return { peerAvgForwardPE: cached.peerAvgForwardPE, peerCount: cached.peerCount };
  }

  const peerSymbolsResult = await getPeerSymbols(symbol);
  const peerSymbols = peerSymbolsResult.peers;

  if (peerSymbols.length === 0) {
    const result = { peerAvgForwardPE: null, peerCount: 0 };
    // Only cache empty result if FMP successfully returned "no peers"
    // Don't cache if FMP failed (429/timeout/etc) - allow retry on next scan
    if (peerSymbolsResult.fetched) {
      peerAvgPECache.set(symbol, { ...result, cachedAt: now });
    }
    return result;
  }

  // Check cache first, only call Yahoo Finance for symbols not in valuation cache
  const peerPEs = await Promise.all(
    peerSymbols.map(async (p) => {
      const cachedPE = getCachedForwardPE(p);
      if (cachedPE !== undefined) {
        return cachedPE; // Use cached value (includes null for known failures)
      }
      return getForwardPEOnly(p);
    })
  );

  console.log(`[Peers] Forward P/E lookup for ${symbol}`, {
    peerSymbols,
    peerPEs,
  });

  const validPEs = peerPEs.filter((pe): pe is number => pe !== null && pe !== undefined && pe > 0 && isFinite(pe));

  console.log(`[Peers] Valid peer Forward P/E for ${symbol}`, {
    validCount: validPEs.length,
    validPEs,
  });

  if (validPEs.length === 0) {
    const result = { peerAvgForwardPE: null, peerCount: 0 };
    peerAvgPECache.set(symbol, { ...result, cachedAt: now });
    return result;
  }

  // Use median to avoid outliers
  const sorted = [...validPEs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const result = { peerAvgForwardPE: median, peerCount: validPEs.length };
  peerAvgPECache.set(symbol, { ...result, cachedAt: now });

  return result;
}

/**
 * Post-processing: Enrich ATH/ATL records with valuation data
 * This is called after the main scan completes with the smaller result list
 */
async function enrichWithValuationData(
  records: ATHATLRecord[],
  dateField: "ath_date" | "atl_date"
): Promise<void> {
  // Find the latest creation date in this result list
  const latestDate = getLatestResultDate(records, dateField);

  console.log(`[Valuation] Enriching ${records.length} records`, { dateField, latestDate });

  await Promise.all(
    records.map(async (record) => {
      try {
        // Determine if this record should include peer data (only the latest dates get peer)
        const includePeerData = latestDate !== null && record[dateField] === latestDate;

        console.log(`[Valuation] ${record.symbol}`, {
          recordDate: record[dateField],
          latestDate,
          includePeerData,
        });

        const v = await getValuationMetrics(record.symbol, { includePeerData });
        record.forwardPE = v.forwardPE;
        record.pegNearTerm = v.pegNearTerm;
        record.pegLongTerm = v.pegLongTerm;
        record.nearTermGrowthPct = v.nearTermGrowthPct;
        record.longTermGrowthPct = v.longTermGrowthPct;
        record.priceToSales = v.priceToSales;
        record.priceToBook = v.priceToBook;
        record.peBookHistoricalPercentile = v.peBookHistoricalPercentile;
        record.dividendYield = v.dividendYield;
        record.sectorCategory = v.sectorCategory;
        record.primaryValuationMetric = v.primaryValuationMetric;
        record.isProfitable = v.isProfitable;
        record.sector = v.sector;
        record.gicsIndustry = v.industry;
        record.industry = v.industry ?? "";
        // Non-latest dates don't get peer data - fields remain null/0
        record.peerAvgForwardPE = v.peerAvgForwardPE;
        record.peerCount = v.peerCount;
      } catch (e) {
        console.error(`[Valuation] Enrichment failed for ${record.symbol}:`, e);
      }
    })
  );
}

/**
 * Find the latest result date in the records
 */
function getLatestResultDate(records: ATHATLRecord[], dateField: "ath_date" | "atl_date"): string | null {
  const dates = records
    .map((record) => record[dateField])
    .filter((date): date is string => Boolean(date));

  if (dates.length === 0) return null;

  return dates.reduce((latest, date) => (date > latest ? date : latest));
}

// ============ Stock List Fetching Functions ============

interface SECCompanyTicker {
  cik_str: number;
  ticker: string;
  title: string;
}

interface SECResponse {
  count?: number;
  [key: string]: SECCompanyTicker | number | undefined;
}

/**
 * Fetch S&P 500 companies from Wikipedia
 */
async function fetchSP500FromWikipedia(): Promise<StockInfo[]> {
  const url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "StockSR-App/1.0 (https://stocksr.online; contact@stocksr.online)",
    },
  });
  
  const $ = cheerio.load(res.data);
  const stocks: StockInfo[] = [];
  
  $("#constituents tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    
    const symbol = $(cells[0]).text().trim().replace(".", "-");
    const name = $(cells[1]).text().trim();
    const exchangeText = $(cells[2])?.text().trim().toUpperCase() || "NYSE";
    
    if (symbol && name) {
      stocks.push({
        symbol: symbol.toUpperCase(),
        exchange: exchangeText.includes("NASDAQ") ? "NASDAQ" : exchangeText.includes("AMEX") ? "AMEX" : "NYSE",
        companyName: name,
      });
    }
  });
  
  if (stocks.length === 0) {
    throw new Error("Wikipedia S&P 500 scrape returned no stocks");
  }
  
  console.log(`[StockList] Loaded ${stocks.length} S&P 500 stocks from Wikipedia`);
  return stocks;
}

/**
 * Fetch NASDAQ-100 companies from Wikipedia
 */
async function fetchNASDAQ100FromWikipedia(): Promise<StockInfo[]> {
  const url = "https://en.wikipedia.org/wiki/NASDAQ-100";
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "StockSR-App/1.0 (https://stocksr.online; contact@stocksr.online)",
    },
  });
  
  const $ = cheerio.load(res.data);
  const stocks: StockInfo[] = [];
  
  // NASDAQ-100 table structure varies, try multiple selectors
  const rows = $(".wikitable tbody tr, . sortable tbody tr");
  
  $(rows).each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    
    // First column is usually the ticker
    const symbol = $(cells[0]).text().trim().replace(/\[.*?\]/g, "").replace(".", "-");
    const name = $(cells[1])?.text().trim() || $(cells[0]).attr("title") || "";
    
    if (symbol && symbol.length <= 5 && /^[A-Z]+$/.test(symbol.replace(/-/g, ""))) {
      stocks.push({
        symbol: symbol.toUpperCase(),
        exchange: "NASDAQ",
        companyName: name || symbol,
      });
    }
  });
  
  if (stocks.length === 0) {
    // Try alternative: look for links with ticker-like text
    $("a").each((_, el) => {
      const text = $(el).text().trim().toUpperCase();
      if (text.length >= 1 && text.length <= 5 && /^[A-Z]+$/.test(text)) {
        if (!stocks.find(s => s.symbol === text)) {
          stocks.push({
            symbol: text,
            exchange: "NASDAQ",
            companyName: text,
          });
        }
      }
    });
  }
  
  console.log(`[StockList] Loaded ${stocks.length} NASDAQ-100 stocks from Wikipedia`);
  return stocks;
}

/**
 * Fetch Russell 1000 companies from Wikipedia
 * Source: https://en.wikipedia.org/wiki/Russell_1000_Index
 * Note: Russell 1000 is market-cap weighted, includes growth stocks without盈利門檻 (no GAAP profit requirement)
 */
async function fetchRussell1000FromWikipedia(): Promise<StockInfo[]> {
  const url = "https://en.wikipedia.org/wiki/Russell_1000_Index";
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "StockSR-App/1.0 (https://stocksr.online; contact@stocksr.online)",
    },
  });
  
  const $ = cheerio.load(res.data);
  const stocks: StockInfo[] = [];
  
  // Russell 1000 table structure: Company | Symbol | GICS Sector | GICS Sub-Industry
  // Symbol is in 2nd column (index 1)
  $(".wikitable tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    
    // First cell is company name, second is symbol
    const companyName = $(cells[0]).text().trim();
    const symbol = $(cells[1]).text().trim().replace(".", "-");
    
    if (symbol && companyName && symbol.length <= 5 && /^[A-Z]+$/.test(symbol.replace(/-/g, ""))) {
      stocks.push({
        symbol: symbol.toUpperCase(),
        exchange: "NYSE", // Default, will be corrected if found in other sources
        companyName: companyName,
      });
    }
  });
  
  if (stocks.length === 0) {
    throw new Error("Wikipedia Russell 1000 scrape returned no stocks");
  }
  
  console.log(`[StockList] Loaded ${stocks.length} Russell 1000 stocks from Wikipedia`);
  return stocks;
}

/**
 * Combine S&P 500 + NASDAQ 100 + Russell 1000 and remove duplicates
 */
async function fetchCombinedStockListFromWikipedia(): Promise<StockInfo[]> {
  const [sp500, nasdaq100, russell1000] = await Promise.all([
    fetchSP500FromWikipedia().catch(e => {
      console.error("[StockList] S&P 500 fetch failed:", e);
      return [] as StockInfo[];
    }),
    fetchNASDAQ100FromWikipedia().catch(e => {
      console.error("[StockList] NASDAQ-100 fetch failed:", e);
      return [] as StockInfo[];
    }),
    fetchRussell1000FromWikipedia().catch(e => {
      console.error("[StockList] Russell 1000 fetch failed:", e);
      return [] as StockInfo[];
    }),
  ]);
  
  // Combine and deduplicate by symbol
  const combined = [...sp500, ...nasdaq100, ...russell1000];
  const seen = new Map<string, StockInfo>();
  
  for (const stock of combined) {
    if (!seen.has(stock.symbol)) {
      seen.set(stock.symbol, stock);
    } else {
      // Keep existing if it has better exchange info
      const existing = seen.get(stock.symbol)!;
      // Prefer NYSE/NASDAQ over unknown, and prefer existing if same quality
      if (stock.exchange !== "NYSE" && stock.exchange !== "NASDAQ") {
        // Keep existing
      } else if (existing.exchange !== "NYSE" && existing.exchange !== "NASDAQ") {
        seen.set(stock.symbol, stock);
      } else if (stock.exchange === "NASDAQ" && existing.exchange !== "NASDAQ") {
        // Prefer NASDAQ if existing is not NASDAQ
        seen.set(stock.symbol, { ...stock, companyName: existing.companyName || stock.companyName });
      }
    }
  }
  
  const result = Array.from(seen.values());
  console.log(`[StockList] Combined ${result.length} unique stocks (S&P 500: ${sp500.length}, NASDAQ-100: ${nasdaq100.length}, Russell 1000: ${russell1000.length})`);
  return result;
}

/**
 * Fetch all US stock tickers from SEC.gov
 * Returns company tickers without exchange info (all US listed)
 */
async function fetchAllTickersFromSEC(): Promise<StockInfo[]> {
  const url = "https://www.sec.gov/files/company_tickers.json";
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "StockSR-App/1.0 (https://stocksr.online; contact@stocksr.online)",
    },
  });

  const data = res.data as SECResponse;
  if (!data || Object.keys(data).length === 0) {
    throw new Error("SEC returned empty data");
  }

  const stocks: StockInfo[] = [];
  for (const key of Object.keys(data)) {
    if (key === "count") continue;
    
    const item = data[key] as SECCompanyTicker;
    if (!item || !item.ticker) continue;
    
    const ticker = item.ticker?.trim().toUpperCase();
    const name = item.title?.trim();
    
    // Filter: valid tickers are 1-5 letters, exclude special characters
    if (ticker && name && ticker.length >= 1 && ticker.length <= 5 && /^[A-Z]+$/.test(ticker)) {
      stocks.push({
        symbol: ticker,
        exchange: "NASDAQ", // Default, will be corrected during scan if needed
        companyName: name,
      });
    }
  }

  if (stocks.length === 0) {
    throw new Error("SEC scrape returned no stocks");
  }

  console.log(`[StockList] Loaded ${stocks.length} stocks from SEC.gov`);
  return stocks;
}

/**
 * Fetch US stock list from Wikipedia (S&P 500 + NASDAQ-100 + Russell 1000)
 * Uses cached data if available
 */
export async function fetchUSStockList(): Promise<StockInfo[]> {
  const cachePath = path.join(DATA_DIR, "combined-index-cache.json");
  
  // Try to load from cache first
  try {
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (cached.stocks && cached.stocks.length > 0) {
        console.log(`[StockList] Loaded ${cached.stocks.length} stocks from cache`);
        return cached.stocks;
      }
    }
  } catch (e) {
    console.error("[StockList] Cache read failed:", e);
  }
  
  // No cache, fetch fresh from Wikipedia
  try {
    const stocks = await fetchCombinedStockListFromWikipedia();
    
    // Save to cache
    try {
      fs.writeFileSync(cachePath, JSON.stringify({ stocks, updated: new Date().toISOString() }));
    } catch (e) {
      console.error("[StockList] Cache write failed:", e);
    }
    
    return stocks;
  } catch (e) {
    console.error("[StockList] Wikipedia fetch failed:", e);
    return [];
  }
}

// ============ End Stock List Fetching Functions ============

// 52週新高/新低快取
let cached52wData: { ath52w: ATHATLRecord[]; atl52w: ATHATLRecord[]; lastUpdated: string } | null = null;
let cached52wDataTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes cache

// 從 API 獲取股票清單或使用備用清單
let US_STOCKS: StockInfo[] = [];

// S&P 500 完整列表
const EXPANDED_STOCKS: StockInfo[] = [
  // NASDAQ - 科技股
  { symbol: "AAPL", exchange: "NASDAQ", companyName: "Apple Inc." },
  { symbol: "MSFT", exchange: "NASDAQ", companyName: "Microsoft Corporation" },
  { symbol: "GOOGL", exchange: "NASDAQ", companyName: "Alphabet Inc." },
  { symbol: "GOOG", exchange: "NASDAQ", companyName: "Alphabet Inc. Class C" },
  { symbol: "AMZN", exchange: "NASDAQ", companyName: "Amazon.com Inc." },
  { symbol: "NVDA", exchange: "NASDAQ", companyName: "NVIDIA Corporation" },
  { symbol: "META", exchange: "NASDAQ", companyName: "Meta Platforms Inc." },
  { symbol: "TSLA", exchange: "NASDAQ", companyName: "Tesla Inc." },
  { symbol: "AVGO", exchange: "NASDAQ", companyName: "Broadcom Inc." },
  { symbol: "COST", exchange: "NASDAQ", companyName: "Costco Wholesale" },
  { symbol: "NFLX", exchange: "NASDAQ", companyName: "Netflix Inc." },
  { symbol: "AMD", exchange: "NASDAQ", companyName: "Advanced Micro Devices" },
  { symbol: "INTC", exchange: "NASDAQ", companyName: "Intel Corporation" },
  { symbol: "CRM", exchange: "NASDAQ", companyName: "Salesforce Inc." },
  { symbol: "ADBE", exchange: "NASDAQ", companyName: "Adobe Inc." },
  { symbol: "PEP", exchange: "NASDAQ", companyName: "PepsiCo Inc." },
  { symbol: "QCOM", exchange: "NASDAQ", companyName: "QUALCOMM Inc." },
  { symbol: "TXN", exchange: "NASDAQ", companyName: "Texas Instruments" },
  { symbol: "BKNG", exchange: "NASDAQ", companyName: "Booking Holdings" },
  { symbol: "AMAT", exchange: "NASDAQ", companyName: "Applied Materials" },
  { symbol: "INTU", exchange: "NASDAQ", companyName: "Intuit Inc." },
  { symbol: "AMZN", exchange: "NASDAQ", companyName: "Amazon.com Inc." },
  { symbol: "NOW", exchange: "NASDAQ", companyName: "ServiceNow Inc." },
  { symbol: "SNOW", exchange: "NASDAQ", companyName: "Snowflake Inc." },
  { symbol: "PANW", exchange: "NASDAQ", companyName: "Palo Alto Networks" },
  { symbol: "CRWD", exchange: "NASDAQ", companyName: "CrowdStrike Holdings" },
  { symbol: "DDOG", exchange: "NASDAQ", companyName: "Datadog Inc." },
  { symbol: "NET", exchange: "NASDAQ", companyName: "Cloudflare Inc." },
  { symbol: "XYZ", exchange: "NYSE", companyName: "Block Inc." },
  { symbol: "SHOP", exchange: "NASDAQ", companyName: "Shopify Inc." },
  { symbol: "ROKU", exchange: "NASDAQ", companyName: "Roku Inc." },
  { symbol: "ZM", exchange: "NASDAQ", companyName: "Zoom Video Communications" },
  { symbol: "DOCU", exchange: "NASDAQ", companyName: "DocuSign Inc." },
  { symbol: "UBER", exchange: "NASDAQ", companyName: "Uber Technologies" },
  { symbol: "LYFT", exchange: "NASDAQ", companyName: "Lyft Inc." },
  { symbol: "DASH", exchange: "NASDAQ", companyName: "DoorDash Inc." },
  { symbol: "ABNB", exchange: "NASDAQ", companyName: "Airbnb Inc." },
  { symbol: "PINS", exchange: "NASDAQ", companyName: "Pinterest Inc." },
  { symbol: "SNAP", exchange: "NASDAQ", companyName: "Snap Inc." },
  { symbol: "TWLO", exchange: "NASDAQ", companyName: "Twilio Inc." },
  { symbol: "TEAM", exchange: "NASDAQ", companyName: "Atlassian Corporation" },
  { symbol: "WDAY", exchange: "NASDAQ", companyName: "Workday Inc." },
  { symbol: "OKTA", exchange: "NASDAQ", companyName: "Okta Inc." },
  { symbol: "ZS", exchange: "NASDAQ", companyName: "Zscaler Inc." },
  { symbol: "MDB", exchange: "NASDAQ", companyName: "MongoDB Inc." },
  { symbol: "FTNT", exchange: "NASDAQ", companyName: "Fortinet Inc." },
  { symbol: "CDW", exchange: "NASDAQ", companyName: "CDW Corporation" },
  { symbol: "CTSH", exchange: "NASDAQ", companyName: "Cognizant Technology Solutions" },
  { symbol: "INFY", exchange: "NASDAQ", companyName: "Infosys Ltd." },
  { symbol: "ADP", exchange: "NASDAQ", companyName: "Automatic Data Processing" },
  { symbol: "ISRG", exchange: "NASDAQ", companyName: "Intuitive Surgical" },
  { symbol: "REGN", exchange: "NASDAQ", companyName: "Regeneron Pharmaceuticals" },
  { symbol: "VRTX", exchange: "NASDAQ", companyName: "Vertex Pharmaceuticals" },
  { symbol: "GILD", exchange: "NASDAQ", companyName: "Gilead Sciences" },
  { symbol: "ILMN", exchange: "NASDAQ", companyName: "Illumina Inc." },
  { symbol: "MRNA", exchange: "NASDAQ", companyName: "Moderna Inc." },
  { symbol: "BIIB", exchange: "NASDAQ", companyName: "Biogen Inc." },
  { symbol: "EXAS", exchange: "NASDAQ", companyName: "Exact Sciences Corporation" },
  { symbol: "ALGN", exchange: "NASDAQ", companyName: "Align Technology" },
  { symbol: "IDXX", exchange: "NASDAQ", companyName: "IDEXX Laboratories" },
  { symbol: "CTAS", exchange: "NASDAQ", companyName: "Cintas Corporation" },
  { symbol: "ODFL", exchange: "NASDAQ", companyName: "Old Dominion Freight Line" },
  { symbol: "PAYX", exchange: "NASDAQ", companyName: "Paychex Inc." },
  { symbol: "FAST", exchange: "NASDAQ", companyName: "Fastenal Company" },
  { symbol: "ROST", exchange: "NASDAQ", companyName: "Ross Stores" },
  { symbol: "DLTR", exchange: "NASDAQ", companyName: "Dollar Tree Inc." },
  { symbol: "ORLY", exchange: "NASDAQ", companyName: "O'Reilly Automotive" },
  { symbol: "ULTA", exchange: "NASDAQ", companyName: "Ulta Beauty Inc." },
  { symbol: "CMCSA", exchange: "NASDAQ", companyName: "Comcast Corporation" },
  { symbol: "T", exchange: "NYSE", companyName: "AT&T Inc." },
  { symbol: "VZ", exchange: "NYSE", companyName: "Verizon Communications" },
  { symbol: "TMUS", exchange: "NASDAQ", companyName: "T-Mobile US" },
  { symbol: "MSFT", exchange: "NASDAQ", companyName: "Microsoft Corporation" },
  { symbol: "GOOGL", exchange: "NASDAQ", companyName: "Alphabet Inc." },
  { symbol: "GOOG", exchange: "NASDAQ", companyName: "Alphabet Inc. Class C" },
  { symbol: "AMZN", exchange: "NASDAQ", companyName: "Amazon.com Inc." },
  { symbol: "NVDA", exchange: "NASDAQ", companyName: "NVIDIA Corporation" },
  { symbol: "META", exchange: "NASDAQ", companyName: "Meta Platforms Inc." },
  { symbol: "TSLA", exchange: "NASDAQ", companyName: "Tesla Inc." },
  { symbol: "AVGO", exchange: "NASDAQ", companyName: "Broadcom Inc." },
  { symbol: "COST", exchange: "NASDAQ", companyName: "Costco Wholesale" },
  { symbol: "NFLX", exchange: "NASDAQ", companyName: "Netflix Inc." },
  { symbol: "AMD", exchange: "NASDAQ", companyName: "Advanced Micro Devices" },
  { symbol: "INTC", exchange: "NASDAQ", companyName: "Intel Corporation" },
  { symbol: "CRM", exchange: "NASDAQ", companyName: "Salesforce Inc." },
  { symbol: "ADBE", exchange: "NASDAQ", companyName: "Adobe Inc." },
  { symbol: "PEP", exchange: "NASDAQ", companyName: "PepsiCo Inc." },
  { symbol: "QCOM", exchange: "NASDAQ", companyName: "QUALCOMM Inc." },
  { symbol: "TXN", exchange: "NASDAQ", companyName: "Texas Instruments" },
  { symbol: "BKNG", exchange: "NASDAQ", companyName: "Booking Holdings" },
  { symbol: "AMAT", exchange: "NASDAQ", companyName: "Applied Materials" },
  { symbol: "INTU", exchange: "NASDAQ", companyName: "Intuit Inc." },
  { symbol: "AMZN", exchange: "NASDAQ", companyName: "Amazon.com Inc." },
  { symbol: "NOW", exchange: "NASDAQ", companyName: "ServiceNow Inc." },
  { symbol: "SNOW", exchange: "NASDAQ", companyName: "Snowflake Inc." },
  { symbol: "PANW", exchange: "NASDAQ", companyName: "Palo Alto Networks" },
  { symbol: "CRWD", exchange: "NASDAQ", companyName: "CrowdStrike Holdings" },
  { symbol: "DDOG", exchange: "NASDAQ", companyName: "Datadog Inc." },
  { symbol: "NET", exchange: "NASDAQ", companyName: "Cloudflare Inc." },
  { symbol: "XYZ", exchange: "NYSE", companyName: "Block Inc." },
  { symbol: "SHOP", exchange: "NASDAQ", companyName: "Shopify Inc." },
  { symbol: "ROKU", exchange: "NASDAQ", companyName: "Roku Inc." },
  { symbol: "ZM", exchange: "NASDAQ", companyName: "Zoom Video Communications" },
  { symbol: "DOCU", exchange: "NASDAQ", companyName: "DocuSign Inc." },
  { symbol: "UBER", exchange: "NASDAQ", companyName: "Uber Technologies" },
  { symbol: "LYFT", exchange: "NASDAQ", companyName: "Lyft Inc." },
  { symbol: "DASH", exchange: "NASDAQ", companyName: "DoorDash Inc." },
  { symbol: "ABNB", exchange: "NASDAQ", companyName: "Airbnb Inc." },
  { symbol: "PINS", exchange: "NASDAQ", companyName: "Pinterest Inc." },
  { symbol: "SNAP", exchange: "NASDAQ", companyName: "Snap Inc." },
  { symbol: "TWLO", exchange: "NASDAQ", companyName: "Twilio Inc." },
  { symbol: "TEAM", exchange: "NASDAQ", companyName: "Atlassian Corporation" },
  { symbol: "WDAY", exchange: "NASDAQ", companyName: "Workday Inc." },
  { symbol: "OKTA", exchange: "NASDAQ", companyName: "Okta Inc." },
  { symbol: "ZS", exchange: "NASDAQ", companyName: "Zscaler Inc." },
  { symbol: "MDB", exchange: "NASDAQ", companyName: "MongoDB Inc." },
  { symbol: "FTNT", exchange: "NASDAQ", companyName: "Fortinet Inc." },
  { symbol: "CDW", exchange: "NASDAQ", companyName: "CDW Corporation" },
  { symbol: "CTSH", exchange: "NASDAQ", companyName: "Cognizant Technology Solutions" },
  { symbol: "INFY", exchange: "NASDAQ", companyName: "Infosys Ltd." },
  { symbol: "ADP", exchange: "NASDAQ", companyName: "Automatic Data Processing" },
  { symbol: "ISRG", exchange: "NASDAQ", companyName: "Intuitive Surgical" },
  { symbol: "REGN", exchange: "NASDAQ", companyName: "Regeneron Pharmaceuticals" },
  { symbol: "VRTX", exchange: "NASDAQ", companyName: "Vertex Pharmaceuticals" },
  { symbol: "GILD", exchange: "NASDAQ", companyName: "Gilead Sciences" },
  { symbol: "ILMN", exchange: "NASDAQ", companyName: "Illumina Inc." },
  { symbol: "MRNA", exchange: "NASDAQ", companyName: "Moderna Inc." },
  { symbol: "BIIB", exchange: "NASDAQ", companyName: "Biogen Inc." },
  { symbol: "EXAS", exchange: "NASDAQ", companyName: "Exact Sciences Corporation" },
  { symbol: "ALGN", exchange: "NASDAQ", companyName: "Align Technology" },
  { symbol: "IDXX", exchange: "NASDAQ", companyName: "IDEXX Laboratories" },
  { symbol: "CTAS", exchange: "NASDAQ", companyName: "Cintas Corporation" },
  { symbol: "ODFL", exchange: "NASDAQ", companyName: "Old Dominion Freight Line" },
  { symbol: "PAYX", exchange: "NASDAQ", companyName: "Paychex Inc." },
  { symbol: "FAST", exchange: "NASDAQ", companyName: "Fastenal Company" },
  { symbol: "ROST", exchange: "NASDAQ", companyName: "Ross Stores" },
  { symbol: "DLTR", exchange: "NASDAQ", companyName: "Dollar Tree Inc." },
  { symbol: "COST", exchange: "NASDAQ", companyName: "Costco Wholesale" },
  { symbol: "ORLY", exchange: "NASDAQ", companyName: "O'Reilly Automotive" },
  { symbol: "ULTA", exchange: "NASDAQ", companyName: "Ulta Beauty Inc." },
  { symbol: "CMCSA", exchange: "NASDAQ", companyName: "Comcast Corporation" },
  { symbol: "T", exchange: "NYSE", companyName: "AT&T Inc." },
  { symbol: "VZ", exchange: "NYSE", companyName: "Verizon Communications" },
  { symbol: "TMUS", exchange: "NASDAQ", companyName: "T-Mobile US" },
  // NYSE 藍籌股
  { symbol: "JPM", exchange: "NYSE", companyName: "JPMorgan Chase & Co." },
  { symbol: "V", exchange: "NYSE", companyName: "Visa Inc." },
  { symbol: "JNJ", exchange: "NYSE", companyName: "Johnson & Johnson" },
  { symbol: "WMT", exchange: "NYSE", companyName: "Walmart Inc." },
  { symbol: "PG", exchange: "NYSE", companyName: "Procter & Gamble" },
  { symbol: "UNH", exchange: "NYSE", companyName: "UnitedHealth Group" },
  { symbol: "HD", exchange: "NYSE", companyName: "Home Depot Inc." },
  { symbol: "MA", exchange: "NYSE", companyName: "Mastercard Inc." },
  { symbol: "DIS", exchange: "NYSE", companyName: "Walt Disney Company" },
  { symbol: "BAC", exchange: "NYSE", companyName: "Bank of America" },
  { symbol: "XOM", exchange: "NYSE", companyName: "Exxon Mobil Corporation" },
  { symbol: "KO", exchange: "NYSE", companyName: "Coca-Cola Company" },
  { symbol: "PFE", exchange: "NYSE", companyName: "Pfizer Inc." },
  { symbol: "CVX", exchange: "NYSE", companyName: "Chevron Corporation" },
  { symbol: "ABBV", exchange: "NYSE", companyName: "AbbVie Inc." },
  { symbol: "MRK", exchange: "NYSE", companyName: "Merck & Co." },
  { symbol: "LLY", exchange: "NYSE", companyName: "Eli Lilly and Company" },
  { symbol: "TMO", exchange: "NYSE", companyName: "Thermo Fisher Scientific" },
  { symbol: "ORCL", exchange: "NYSE", companyName: "Oracle Corporation" },
  { symbol: "ACN", exchange: "NYSE", companyName: "Accenture plc" },
  { symbol: "IBM", exchange: "NYSE", companyName: "IBM Corporation" },
  { symbol: "AXP", exchange: "NYSE", companyName: "American Express" },
  { symbol: "GS", exchange: "NYSE", companyName: "Goldman Sachs" },
  { symbol: "MS", exchange: "NYSE", companyName: "Morgan Stanley" },
  { symbol: "C", exchange: "NYSE", companyName: "Citigroup Inc." },
  { symbol: "WFC", exchange: "NYSE", companyName: "Wells Fargo" },
  { symbol: "BLK", exchange: "NYSE", companyName: "BlackRock Inc." },
  { symbol: "SCHW", exchange: "NYSE", companyName: "Charles Schwab" },
  { symbol: "AXP", exchange: "NYSE", companyName: "American Express" },
  { symbol: "SPGI", exchange: "NYSE", companyName: "S&P Global" },
  { symbol: "MCO", exchange: "NYSE", companyName: "Moody's Corporation" },
  { symbol: "BA", exchange: "NYSE", companyName: "Boeing Company" },
  { symbol: "CAT", exchange: "NYSE", companyName: "Caterpillar Inc." },
  { symbol: "GE", exchange: "NYSE", companyName: "General Electric" },
  { symbol: "HON", exchange: "NASDAQ", companyName: "Honeywell International" },
  { symbol: "UPS", exchange: "NYSE", companyName: "United Parcel Service" },
  { symbol: "LMT", exchange: "NYSE", companyName: "Lockheed Martin" },
  { symbol: "RTX", exchange: "NYSE", companyName: "RTX Corporation" },
  { symbol: "NOC", exchange: "NYSE", companyName: "Northrop Grumman" },
  { symbol: "DE", exchange: "NYSE", companyName: "Deere & Company" },
  { symbol: "MMM", exchange: "NYSE", companyName: "3M Company" },
  { symbol: "NKE", exchange: "NYSE", companyName: "Nike Inc." },
  { symbol: "SBUX", exchange: "NASDAQ", companyName: "Starbucks Corporation" },
  { symbol: "MCD", exchange: "NYSE", companyName: "McDonald's Corporation" },
  { symbol: "NEE", exchange: "NYSE", companyName: "NextEra Energy" },
  { symbol: "DUK", exchange: "NYSE", companyName: "Duke Energy" },
  { symbol: "SO", exchange: "NYSE", companyName: "Southern Company" },
  { symbol: "D", exchange: "NYSE", companyName: "Dominion Energy" },
  { symbol: "AEP", exchange: "NYSE", companyName: "American Electric Power" },
  { symbol: "SRE", exchange: "NYSE", companyName: "Sempra Energy" },
  { symbol: "PLD", exchange: "NYSE", companyName: "Prologis Inc." },
  { symbol: "AMT", exchange: "NYSE", companyName: "American Tower Corporation" },
  { symbol: "EQIX", exchange: "NASDAQ", companyName: "Equinix Inc." },
  { symbol: "CCI", exchange: "NYSE", companyName: "Crown Castle Inc." },
  // AMEX ETF
  { symbol: "SPY", exchange: "AMEX", companyName: "SPDR S&P 500 ETF" },
  { symbol: "QQQ", exchange: "AMEX", companyName: "Invesco QQQ Trust" },
  { symbol: "IWM", exchange: "AMEX", companyName: "iShares Russell 2000" },
  { symbol: "DIA", exchange: "AMEX", companyName: "SPDR Dow Jones ETF" },
  { symbol: "ARKK", exchange: "AMEX", companyName: "ARK Innovation ETF" },
  { symbol: "SLV", exchange: "AMEX", companyName: "iShares Silver Trust" },
  { symbol: "GLD", exchange: "AMEX", companyName: "SPDR Gold Shares" },
  { symbol: "XLF", exchange: "AMEX", companyName: "Financial Select Sector SPDR" },
  { symbol: "XLE", exchange: "AMEX", companyName: "Energy Select Sector SPDR" },
  { symbol: "XLV", exchange: "AMEX", companyName: "Health Care Select Sector SPDR" },
  { symbol: "XLK", exchange: "AMEX", companyName: "Technology Select Sector SPDR" },
  { symbol: "XLI", exchange: "AMEX", companyName: "Industrial Select Sector SPDR" },
  { symbol: "XLC", exchange: "AMEX", companyName: "Communication Services Select SPDR" },
  { symbol: "XLY", exchange: "AMEX", companyName: "Consumer Discretionary Select SPDR" },
  { symbol: "XLP", exchange: "AMEX", companyName: "Consumer Staples Select SPDR" },
  { symbol: "XLB", exchange: "AMEX", companyName: "Materials Select Sector SPDR" },
  { symbol: "XLRE", exchange: "AMEX", companyName: "Real Estate Select Sector SPDR" },
  { symbol: "XLU", exchange: "AMEX", companyName: "Utilities Select Sector SPDR" },
  { symbol: "VOO", exchange: "AMEX", companyName: "Vanguard S&P 500 ETF" },
  { symbol: "VTI", exchange: "AMEX", companyName: "Vanguard Total Stock Market ETF" },
  { symbol: "VEA", exchange: "AMEX", companyName: "Vanguard FTSE Developed Markets ETF" },
  { symbol: "VWO", exchange: "AMEX", companyName: "Vanguard FTSE Emerging Markets ETF" },
  { symbol: "BND", exchange: "AMEX", companyName: "Vanguard Total Bond Market ETF" },
  { symbol: "AGG", exchange: "AMEX", companyName: "iShares Core US Aggregate Bond ETF" },
  { symbol: "TLT", exchange: "AMEX", companyName: "iShares 20+ Year Treasury Bond ETF" },
  { symbol: "HYG", exchange: "AMEX", companyName: "iShares iBoxx $ High Yield Corporate Bond ETF" },
  { symbol: "LQD", exchange: "AMEX", companyName: "iShares iBoxx $ Investment Grade Corporate Bond ETF" },
  { symbol: "USO", exchange: "AMEX", companyName: "United States Oil Fund" },
  { symbol: "UNG", exchange: "AMEX", companyName: "United States Natural Gas Fund" },
  { symbol: "DBC", exchange: "AMEX", companyName: "Invesco DB Commodity Index Tracking Fund" },
  { symbol: "EEM", exchange: "AMEX", companyName: "iShares MSCI Emerging Markets ETF" },
  { symbol: "IEMG", exchange: "AMEX", companyName: "iShares Core MSCI Emerging Markets ETF" },
  { symbol: "VIG", exchange: "AMEX", companyName: "Vanguard Dividend Appreciation ETF" },
  { symbol: "SCHD", exchange: "AMEX", companyName: "Schwab US Dividend Equity ETF" },
  { symbol: "JEPI", exchange: "AMEX", companyName: "JPMorgan Equity Premium Income ETF" },
  { symbol: "JEPQ", exchange: "AMEX", companyName: "JPMorgan Nasdaq Equity Premium Income ETF" },
  { symbol: "VYM", exchange: "AMEX", companyName: "Vanguard High Dividend Yield ETF" },
  { symbol: "HDV", exchange: "AMEX", companyName: "iShares Core High Dividend ETF" },
  { symbol: "SPHD", exchange: "AMEX", companyName: "Invesco S&P 500 High Dividend Low Volatility ETF" },
  { symbol: "SPKB", exchange: "AMEX", companyName: "Invesco S&P 500 KBW Bank ETF" },
  { symbol: "SMH", exchange: "AMEX", companyName: "VanEck Semiconductor ETF" },
  { symbol: "SOXX", exchange: "AMEX", companyName: "iShares Semiconductor ETF" },
  { symbol: "XSD", exchange: "AMEX", companyName: "SPDR S&P Semiconductor ETF" },
  { symbol: "KWEB", exchange: "AMEX", companyName: "KraneShares CSI China Internet ETF" },
  { symbol: "CQQQ", exchange: "AMEX", companyName: "Invesco China Technology ETF" },
  { symbol: "EWJ", exchange: "AMEX", companyName: "iShares MSCI Japan ETF" },
  { symbol: "EWZ", exchange: "AMEX", companyName: "iShares MSCI Brazil Capped ETF" },
  { symbol: "EWG", exchange: "AMEX", companyName: "iShares MSCI Germany ETF" },
  { symbol: "EWU", exchange: "AMEX", companyName: "iShares MSCI United Kingdom ETF" },
  { symbol: "FLOT", exchange: "AMEX", companyName: "iShares Floating Rate Bond ETF" },
  { symbol: "SHV", exchange: "AMEX", companyName: "iShares Short Treasury Bond ETF" },
  { symbol: "BIL", exchange: "AMEX", companyName: "SPDR Bloomberg 1-3 Month T-Bill ETF" },
  { symbol: "SGOV", exchange: "AMEX", companyName: "iShares 0-3 Month Treasury Bond ETF" },
];

let cachedData: { ath: ATHATLRecord[]; atl: ATHATLRecord[]; lastUpdated: string } | null = null;
let cachedDataTime = 0;
let isScanning = false;
let isScanning52w = false;

export function getUSStocks(): StockInfo[] {
  // If US_STOCKS has been populated from FMP/Wikipedia, use it
  // Otherwise fall back to EXPANDED_STOCKS
  const stocks = US_STOCKS.length > 0 ? US_STOCKS : EXPANDED_STOCKS;
  // 去重
  const seen = new Set<string>();
  return stocks.filter(s => {
    if (seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });
}

/**
 * Audit stale tickers in EXPANDED_STOCKS
 * Compares EXPANDED_STOCKS symbols against the live combined stock list
 * to detect tickers that are no longer valid (e.g., ticker changes, delistings)
 * 
 * This can be run manually to identify tickers that need updating:
 *   import { auditStaleTickers } from './stocks';
 *   auditStaleTickers().then(console.log);
 */
export async function auditStaleTickers(): Promise<{ stale: StockInfo[]; valid: StockInfo[] }> {
  let liveStocks: StockInfo[] = [];
  
  try {
    liveStocks = await fetchCombinedStockListFromWikipedia();
  } catch (e) {
    console.error("[Audit] Failed to fetch live stock list:", e);
    // Fallback: try cached data
    const cachePath = path.join(DATA_DIR, "combined-index-cache.json");
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        liveStocks = cached.stocks || [];
        console.log("[Audit] Using cached data for audit");
      } catch (e2) {
        console.error("[Audit] Failed to read cache:", e2);
      }
    }
  }
  
  const liveSymbols = new Set(liveStocks.map(s => s.symbol));
  const stale: StockInfo[] = [];
  const valid: StockInfo[] = [];
  
  for (const stock of EXPANDED_STOCKS) {
    if (liveSymbols.has(stock.symbol)) {
      valid.push(stock);
    } else {
      stale.push(stock);
      console.warn(`[Audit] Stale ticker: ${stock.symbol} (${stock.companyName}) - not found in live data`);
    }
  }
  
  console.log(`[Audit] Complete: ${valid.length} valid, ${stale.length} stale tickers`);
  return { stale, valid };
}

/**
 * Initialize stock list from FMP or Wikipedia on server startup
 */
export async function initializeStockList(): Promise<void> {
  if (US_STOCKS.length > 0) {
    console.log(`[StockList] Already initialized with ${US_STOCKS.length} stocks`);
    return;
  }

  try {
    const stocks = await fetchUSStockList();
    US_STOCKS = stocks.length > 0 ? stocks : EXPANDED_STOCKS;
    console.log(`[StockList] Initialized with ${US_STOCKS.length} stocks from FMP/Wikipedia`);
  } catch (e) {
    console.error("[StockList] Failed to fetch stock list, using fallback:", e);
    US_STOCKS = EXPANDED_STOCKS;
  }
}

// Track if initial cache warming is complete
let cacheWarmingComplete = false;

export async function scanAthAtl(forceRefresh = false): Promise<{ ath: ATHATLRecord[]; atl: ATHATLRecord[]; lastUpdated: string }> {
  const now = Date.now();
  
  if (!forceRefresh && cachedData && cachedDataTime && (now - cachedDataTime) < CACHE_TTL_MS) {
    console.log("[ATH-ATL] Returning cached scan results", {
      cacheAgeSeconds: Math.round((now - cachedDataTime) / 1000),
      cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000),
    });
    return cachedData;
  }
  
  // Wait for initial cache warming if still in progress
  if (isScanning && !forceRefresh) {
    console.log("[ATH-ATL] Waiting for initial scan to complete...");
    // Wait up to 60 seconds for initial scan
    const startWait = Date.now();
    while (isScanning && (Date.now() - startWait) < 60000) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (cachedData) {
      console.log("[ATH-ATL] Returning data after waiting for initial scan");
      return cachedData;
    }
  }
  
  if (isScanning && !cachedData) {
    console.log("[ATH-ATL] Scan already in progress, returning cached data");
    return cachedData || { ath: [], atl: [], lastUpdated: "" };
  }

  if (US_STOCKS.length === 0) {
    await initializeStockList();
  }

  isScanning = true;
  const results: { ath: ATHATLRecord[]; atl: ATHATLRecord[]; lastUpdated: string } = {
    ath: [],
    atl: [],
    lastUpdated: new Date().toISOString(),
  };

  const stocksToScan = getUSStocks();
  console.log(`[ATH-ATL] Starting scan for ${stocksToScan.length} stocks...`);

  // 批量處理，每批 50 個 (increased for speed)
  const batchSize = 50;
  for (let i = 0; i < stocksToScan.length; i += batchSize) {
    const batch = stocksToScan.slice(i, i + batchSize);
    console.log(`[ATH-ATL] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(stocksToScan.length / batchSize)}`);
    
    const promises = batch.map(async (stock) => {
      try {
        const result = await scanSingleStock(stock);
        return result;
      } catch (e) {
        console.error(`[ATH-ATL] Error scanning ${stock.symbol}:`, e);
        return null;
      }
    });

    const batchResults = await Promise.all(promises);
    
    for (const r of batchResults) {
      if (r) {
        if (r.list_type === "ATH" && r.ath_price !== null) {
          results.ath.push(r);
        } else if (r.list_type === "ATL" && r.atl_price !== null) {
          results.atl.push(r);
        }
      }
    }
  }

  // 按漲跌幅排序
  results.ath.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
  results.atl.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

  // Post-processing: enrich with valuation data
  await enrichWithValuationData(results.ath, "ath_date");
  await enrichWithValuationData(results.atl, "atl_date");

  cachedData = results;
  cachedDataTime = Date.now();
  isScanning = false;
  cacheWarmingComplete = true;

  console.log(`[ATH-ATL] Scan complete: ${results.ath.length} ATH, ${results.atl.length} ATL`);

  // 保存到檔案作為備份
  const cachePath = path.join(DATA_DIR, "ath-atl-cache.json");
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(results, null, 2));
  } catch (e) {
    console.error("[ATH-ATL] Failed to save cache:", e);
  }

  return results;
}

async function scanSingleStock(stock: StockInfo): Promise<ATHATLRecord | null> {
  try {
    // 獲取過去 5 年數據足夠計算 ATH/ATL (更快)
    // Use today's date to get the latest available data from Yahoo Finance
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 5);

    // Parallel fetch: chart data and earnings date only (valuation done in post-processing)
    const [chart, earningsInfo] = await Promise.all([
      yahooFinance.chart(stock.symbol, {
        period1: startDate,
        period2: endDate,
        interval: "1d",
      }),
      getNextEarningsDate(stock.symbol),
    ]);

    const hist = chart?.quotes ?? [];

    if (!hist || hist.length < 10) {
      return null;
    }

    // 依日期排序
    hist.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // 取得最近 30 天的數據 (擴大範圍以找到更多 ATH/ATL)
    const recentDays = hist.slice(-30);
    const latestData = hist[hist.length - 1];
    const previousData = hist.length >= 2 ? hist[hist.length - 2] : null;

    if (!latestData || !latestData.close) {
      return null;
    }

    // 計算歷史最高/最低價
    const allHighs = hist.map((d) => d.high);
    const allLows = hist.map((d) => d.low);
    const ath = Math.max(...allHighs);
    const atl = Math.min(...allLows);

    // 找出創歷史新高/新低的日期
    const athDateEntry = hist.find((d) => d.high === ath);
    const atlDateEntry = hist.find((d) => d.low === atl);

    // 判斷是否在最近 5 天內創新高/新低
    const lastFiveDays = hist.slice(-5);
    const recentHighs = lastFiveDays.map((d) => d.high);
    const recentLows = lastFiveDays.map((d) => d.low);

    const isATH = recentHighs.some((h) => h >= ath);
    const isATL = recentLows.some((l) => l <= atl);

    if (!isATH && !isATL) {
      return null;
    }

    const changePct = previousData
      ? ((latestData.close - previousData.close) / previousData.close) * 100
      : 0;

    if (isATH) {
      return {
        symbol: stock.symbol,
        company_name: stock.companyName,
        exchange: stock.exchange,
        industry: "",  // Will be filled in post-processing
        last_close: latestData.close,
        ath_price: ath,
        ath_date: athDateEntry ? new Date(athDateEntry.date).toISOString().split("T")[0] : null,
        atl_price: null,
        atl_date: null,
        change_pct: Math.round(changePct * 100) / 100,
        volume: latestData.volume || 0,
        list_type: "ATH",
        next_earnings_date: earningsInfo.date,
        days_to_earnings: earningsInfo.daysUntil,
        // Valuation fields - will be filled in post-processing
        forwardPE: null,
        pegNearTerm: null,
        pegLongTerm: null,
        nearTermGrowthPct: null,
        longTermGrowthPct: null,
        priceToSales: null,
        priceToBook: null,
        peBookHistoricalPercentile: null,
        dividendYield: null,
        sectorCategory: "unclassified",
        primaryValuationMetric: "",
        isProfitable: null,
        sector: null,
        gicsIndustry: null,
        peerAvgForwardPE: null,
        peerCount: 0,
      };
    } else {
      return {
        symbol: stock.symbol,
        company_name: stock.companyName,
        exchange: stock.exchange,
        industry: "",
        last_close: latestData.close,
        ath_price: null,
        ath_date: null,
        atl_price: atl,
        atl_date: atlDateEntry ? new Date(atlDateEntry.date).toISOString().split("T")[0] : null,
        change_pct: Math.round(changePct * 100) / 100,
        volume: latestData.volume || 0,
        list_type: "ATL",
        next_earnings_date: earningsInfo.date,
        days_to_earnings: earningsInfo.daysUntil,
        // Valuation fields - will be filled in post-processing
        forwardPE: null,
        pegNearTerm: null,
        pegLongTerm: null,
        nearTermGrowthPct: null,
        longTermGrowthPct: null,
        priceToSales: null,
        priceToBook: null,
        peBookHistoricalPercentile: null,
        dividendYield: null,
        sectorCategory: "unclassified",
        primaryValuationMetric: "",
        isProfitable: null,
        sector: null,
        gicsIndustry: null,
        peerAvgForwardPE: null,
        peerCount: 0,
      };
    }
  } catch (e) {
    console.error(`[ATH-ATL] Error fetching ${stock.symbol}:`, e);
    return null;
  }
}

export function getCachedData(): { ath: ATHATLRecord[]; atl: ATHATLRecord[]; lastUpdated: string } | null {
  return cachedData;
}

// 52週新高/新低掃描
export async function scan52wAthAtl(forceRefresh = false): Promise<{ ath52w: ATHATLRecord[]; atl52w: ATHATLRecord[]; lastUpdated: string }> {
  const now = Date.now();
  if (!forceRefresh && cached52wData && cached52wDataTime && (now - cached52wDataTime) < CACHE_TTL_MS) {
    console.log(`[52W] Using cached data (age: ${Math.round((now - cached52wDataTime) / 1000)}s)`);
    return cached52wData;
  }

  // Wait for initial cache warming if still in progress
  if (isScanning52w && !forceRefresh) {
    console.log("[52W] Waiting for initial scan to complete...");
    const startWait = Date.now();
    while (isScanning52w && (Date.now() - startWait) < 60000) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (cached52wData) {
      console.log("[52W] Returning data after waiting for initial scan");
      return cached52wData;
    }
  }

  const results: { ath52w: ATHATLRecord[]; atl52w: ATHATLRecord[]; lastUpdated: string } = {
    ath52w: [],
    atl52w: [],
    lastUpdated: new Date().toISOString(),
  };

  if (US_STOCKS.length === 0) {
    await initializeStockList();
  }

  isScanning52w = true;
  const stocksToScan = getUSStocks();
  console.log(`[52W] Starting scan for ${stocksToScan.length} stocks...`);

  // 批量處理，每批 50 個
  const batchSize = 50;
  for (let i = 0; i < stocksToScan.length; i += batchSize) {
    const batch = stocksToScan.slice(i, i + batchSize);
    console.log(`[52W] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(stocksToScan.length / batchSize)}`);
    
    const promises = batch.map(async (stock) => {
      try {
        const result = await scanSingleStock52w(stock);
        return result;
      } catch (e) {
        console.error(`[52W] Error scanning ${stock.symbol}:`, e);
        return null;
      }
    });

    const batchResults = await Promise.all(promises);
    
    for (const r of batchResults) {
      if (r) {
        if (r.list_type === "52W_ATH" && r.ath_price !== null) {
          results.ath52w.push(r);
        } else if (r.list_type === "52W_ATL" && r.atl_price !== null) {
          results.atl52w.push(r);
        }
      }
    }
  }

  // 按漲跌幅排序
  results.ath52w.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
  results.atl52w.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

  // Post-processing: enrich with valuation data
  await enrichWithValuationData(results.ath52w, "ath_date");
  await enrichWithValuationData(results.atl52w, "atl_date");

  cached52wData = results;
  cached52wDataTime = Date.now();
  isScanning52w = false;
  console.log(`[52W] Scan complete: ${results.ath52w.length} 52W ATH, ${results.atl52w.length} 52W ATL`);

  // Save to file cache
  const cachePath = path.join(DATA_DIR, "52w-cache.json");
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ ...results, cachedAt: cached52wDataTime }, null, 2));
  } catch (e) {
    console.error("[52W] Failed to save cache:", e);
  }

  return results;
}

async function scanSingleStock52w(stock: StockInfo): Promise<ATHATLRecord | null> {
  try {
    // 獲取過去2年的數據以確保涵蓋52週
    // Use today's date to get the latest available data from Yahoo Finance
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);

    // Parallel fetch: chart data and earnings date only (valuation done in post-processing)
    const [chart, earningsInfo] = await Promise.all([
      yahooFinance.chart(stock.symbol, {
        period1: startDate,
        period2: endDate,
        interval: "1d",
      }),
      getNextEarningsDate(stock.symbol),
    ]);

    const hist = chart?.quotes ?? [];

    if (!hist || hist.length < 50) {
      return null;
    }

    // 依日期排序
    hist.sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime());

    // 取得過去52週（約252個交易日）的數據
    const last252Days = hist.slice(-252);
    if (last252Days.length < 50) {
      return null;
    }

    const latestData = hist[hist.length - 1];
    const previousData = hist.length >= 2 ? hist[hist.length - 2] : null;

    if (!latestData || !latestData.close) {
      return null;
    }

    // 計算52週最高/最低價
    const highs52w = last252Days.map((d) => d.high);
    const lows52w = last252Days.map((d) => d.low);
    const high52w = Math.max(...highs52w);
    const low52w = Math.min(...lows52w);

    // 找出52週新高/新低的日期
    const high52wDateEntry = last252Days.find((d) => d.high === high52w);
    const low52wDateEntry = last252Days.find((d) => d.low === low52w);

    // 判斷是否在最近5天內觸及52週新高/新低
    const lastFiveDays = hist.slice(-5);
    const recentHighs = lastFiveDays.map((d) => d.high);
    const recentLows = lastFiveDays.map((d) => d.low);

    const is52wATH = recentHighs.some((h) => h >= high52w);
    const is52wATL = recentLows.some((l) => l <= low52w);

    if (!is52wATH && !is52wATL) {
      return null;
    }

    const changePct = previousData
      ? ((latestData.close - previousData.close) / previousData.close) * 100
      : 0;

    if (is52wATH) {
      return {
        symbol: stock.symbol,
        company_name: stock.companyName,
        exchange: stock.exchange,
        industry: "",  // Will be filled in post-processing
        last_close: latestData.close,
        ath_price: high52w,
        ath_date: high52wDateEntry ? new Date(high52wDateEntry.date).toISOString().split("T")[0] : null,
        atl_price: null,
        atl_date: null,
        change_pct: Math.round(changePct * 100) / 100,
        volume: latestData.volume || 0,
        list_type: "52W_ATH",
        next_earnings_date: earningsInfo.date,
        days_to_earnings: earningsInfo.daysUntil,
        // Valuation fields - will be filled in post-processing
        forwardPE: null,
        pegNearTerm: null,
        pegLongTerm: null,
        nearTermGrowthPct: null,
        longTermGrowthPct: null,
        priceToSales: null,
        priceToBook: null,
        peBookHistoricalPercentile: null,
        dividendYield: null,
        sectorCategory: "unclassified",
        primaryValuationMetric: "",
        isProfitable: null,
        sector: null,
        gicsIndustry: null,
        peerAvgForwardPE: null,
        peerCount: 0,
      };
    } else {
      return {
        symbol: stock.symbol,
        company_name: stock.companyName,
        exchange: stock.exchange,
        industry: "",
        last_close: latestData.close,
        ath_price: null,
        ath_date: null,
        atl_price: low52w,
        atl_date: low52wDateEntry ? new Date(low52wDateEntry.date).toISOString().split("T")[0] : null,
        change_pct: Math.round(changePct * 100) / 100,
        volume: latestData.volume || 0,
        list_type: "52W_ATL",
        next_earnings_date: earningsInfo.date,
        days_to_earnings: earningsInfo.daysUntil,
        // Valuation fields - will be filled in post-processing
        forwardPE: null,
        pegNearTerm: null,
        pegLongTerm: null,
        nearTermGrowthPct: null,
        longTermGrowthPct: null,
        priceToSales: null,
        priceToBook: null,
        peBookHistoricalPercentile: null,
        dividendYield: null,
        sectorCategory: "unclassified",
        primaryValuationMetric: "",
        isProfitable: null,
        sector: null,
        gicsIndustry: null,
        peerAvgForwardPE: null,
        peerCount: 0,
      };
    }
  } catch (e) {
    console.error(`[52W] Error fetching ${stock.symbol}:`, e);
    return null;
  }
}