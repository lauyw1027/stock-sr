import YahooFinancePkg from "yahoo-finance2";
import fs from "node:fs";
import path from "node:path";

// Vercel 的 /var/task 是唯讀，只有 /tmp 可寫入
// 本地開發則使用專案根目錄下的 data/ 資料夾
const DATA_DIR = process.env.VERCEL ? '/tmp' : path.resolve(process.cwd(), 'data');

// Initialize YahooFinance (same as in routes.ts)
const YahooFinance: any = (YahooFinancePkg as any).default ?? YahooFinancePkg;
const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

// Helper function to format date as YYYY-MM-DD in local timezone (避免 toISOString UTC 轉換問題)
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type Exchange = "NYSE" | "NASDAQ" | "AMEX";

export interface StockInfo {
  symbol: string;
  exchange: Exchange;
  companyName: string;
}

export interface ATHATLRecord {
  symbol: string;
  company_name: string;
  exchange: string;
  industry: string;
  last_close: number;
  ath_price: number | null;
  ath_date: string | null;
  atl_price: number | null;
  atl_date: string | null;
  change_pct: number;
  volume: number;
  list_type: "ATH" | "ATL" | "52W_ATH" | "52W_ATL";
}

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
  { symbol: "SQ", exchange: "NASDAQ", companyName: "Block Inc." },
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
  { symbol: "SQ", exchange: "NASDAQ", companyName: "Block Inc." },
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
  const stocks = US_STOCKS.length > 0 ? US_STOCKS : EXPANDED_STOCKS;
  // 去重
  const seen = new Set<string>();
  return stocks.filter(s => {
    if (seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });
}

// Track if initial cache warming is complete
let cacheWarmingComplete = false;

export async function scanAthAtl(forceRefresh = false): Promise<{ ath: ATHATLRecord[]; atl: ATHATLRecord[]; lastUpdated: string }> {
  const now = Date.now();
  
  if (!forceRefresh && cachedData && cachedDataTime && (now - cachedDataTime) < CACHE_TTL_MS) {
    console.log(`[ATH-ATL] Using cached data (age: ${Math.round((now - cachedDataTime) / 1000)}s)`);
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

  isScanning = true;
  const results: { ath: ATHATLRecord[]; atl: ATHATLRecord[]; lastUpdated: string } = {
    ath: [],
    atl: [],
    lastUpdated: new Date().toISOString(),
  };

  const stocksToScan = getUSStocks();
  console.log(`[ATH-ATL] Starting scan for ${stocksToScan.length} stocks...`);

  // 批量處理，每批 25 個 (increased from 10)
  const batchSize = 25;
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

    // 使用 .chart() 避免 historical() 的 null 值嚴格檢查
    const chart = await yahooFinance.chart(stock.symbol, {
      period1: startDate,
      period2: endDate,
      interval: "1d",
    });
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
        last_close: latestData.close,
        ath_price: ath,
        ath_date: athDateEntry ? new Date(athDateEntry.date).toISOString().split("T")[0] : null,
        atl_price: null,
        atl_date: null,
        change_pct: Math.round(changePct * 100) / 100,
        volume: latestData.volume || 0,
        list_type: "ATH",
      };
    } else {
      return {
        symbol: stock.symbol,
        company_name: stock.companyName,
        exchange: stock.exchange,
        last_close: latestData.close,
        ath_price: null,
        ath_date: null,
        atl_price: atl,
        atl_date: atlDateEntry ? new Date(atlDateEntry.date).toISOString().split("T")[0] : null,
        change_pct: Math.round(changePct * 100) / 100,
        volume: latestData.volume || 0,
        list_type: "ATL",
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

  isScanning52w = true;
  const stocksToScan = getUSStocks();
  console.log(`[52W] Starting scan for ${stocksToScan.length} stocks...`);

  // 批量處理
  const batchSize = 10;
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

    // 使用 .chart() 避免 historical() 的 null 值嚴格檢查
    const chart = await yahooFinance.chart(stock.symbol, {
      period1: startDate,
      period2: endDate,
      interval: "1d",
    });
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
        industry: "",
        last_close: latestData.close,
        ath_price: high52w,
        ath_date: high52wDateEntry ? new Date(high52wDateEntry.date).toISOString().split("T")[0] : null,
        atl_price: null,
        atl_date: null,
        change_pct: Math.round(changePct * 100) / 100,
        volume: latestData.volume || 0,
        list_type: "52W_ATH",
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
      };
    }
  } catch (e) {
    console.error(`[52W] Error fetching ${stock.symbol}:`, e);
    return null;
  }
}