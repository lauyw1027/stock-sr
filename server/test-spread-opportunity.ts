/**
 * Test script for spreadOpportunityScan.ts
 * Run with: npx tsx server/test-spread-opportunity.ts
 */

import { scanUniverseForBestSpreadOpportunities, getOptionChainCallCount, clearSpreadOpportunityCache } from "./spreadOpportunityScan";
import { ATHATLRecord } from "./stocks";

// Test with a small sample of stocks (mix of ATH, ATL, and regular)
const testStocks: ATHATLRecord[] = [
  {
    symbol: "NVDA",
    company_name: "NVIDIA Corporation",
    exchange: "NASDAQ",
    industry: "Semiconductors",
    last_close: 120.50,
    ath_price: 125.00,
    ath_date: "2024-01-15",
    atl_price: null,
    atl_date: null,
    change_pct: 2.5,
    volume: 50000000,
    list_type: "ATH",
    next_earnings_date: null,
    days_to_earnings: 30,
    forwardPE: null,
    pegNearTerm: null,
    pegLongTerm: null,
    nearTermGrowthPct: null,
    longTermGrowthPct: null,
    priceToSales: null,
    priceToBook: null,
    peBookHistoricalPercentile: null,
    dividendYield: null,
    sectorCategory: "growth_software",
    primaryValuationMetric: "",
    isProfitable: true,
    sector: "Technology",
    gicsIndustry: "Semiconductors",
    peerAvgForwardPE: null,
    peerCount: 0,
  },
  {
    symbol: "AMD",
    company_name: "Advanced Micro Devices",
    exchange: "NASDAQ",
    industry: "Semiconductors",
    last_close: 180.00,
    ath_price: 190.00,
    ath_date: "2024-01-10",
    atl_price: null,
    atl_date: null,
    change_pct: 1.8,
    volume: 30000000,
    list_type: "ATH",
    next_earnings_date: null,
    days_to_earnings: 45,
    forwardPE: null,
    pegNearTerm: null,
    pegLongTerm: null,
    nearTermGrowthPct: null,
    longTermGrowthPct: null,
    priceToSales: null,
    priceToBook: null,
    peBookHistoricalPercentile: null,
    dividendYield: null,
    sectorCategory: "growth_software",
    primaryValuationMetric: "",
    isProfitable: true,
    sector: "Technology",
    gicsIndustry: "Semiconductors",
    peerAvgForwardPE: null,
    peerCount: 0,
  },
  {
    symbol: "AAPL",
    company_name: "Apple Inc.",
    exchange: "NASDAQ",
    industry: "Consumer Electronics",
    last_close: 185.00,
    ath_price: null,
    ath_date: null,
    atl_price: 170.00,
    atl_date: "2024-01-12",
    change_pct: -1.2,
    volume: 40000000,
    list_type: "ATL",
    next_earnings_date: null,
    days_to_earnings: 60,
    forwardPE: null,
    pegNearTerm: null,
    pegLongTerm: null,
    nearTermGrowthPct: null,
    longTermGrowthPct: null,
    priceToSales: null,
    priceToBook: null,
    peBookHistoricalPercentile: null,
    dividendYield: null,
    sectorCategory: "growth_consumer",
    primaryValuationMetric: "",
    isProfitable: true,
    sector: "Technology",
    gicsIndustry: "Consumer Electronics",
    peerAvgForwardPE: null,
    peerCount: 0,
  },
  {
    symbol: "MSFT",
    company_name: "Microsoft Corporation",
    exchange: "NASDAQ",
    industry: "Software",
    last_close: 400.00,
    ath_price: 420.00,
    ath_date: "2024-01-08",
    atl_price: null,
    atl_date: null,
    change_pct: 0.5,
    volume: 20000000,
    list_type: "ATH",
    next_earnings_date: null,
    days_to_earnings: 90,
    forwardPE: null,
    pegNearTerm: null,
    pegLongTerm: null,
    nearTermGrowthPct: null,
    longTermGrowthPct: null,
    priceToSales: null,
    priceToBook: null,
    peBookHistoricalPercentile: null,
    dividendYield: null,
    sectorCategory: "growth_software",
    primaryValuationMetric: "",
    isProfitable: true,
    sector: "Technology",
    gicsIndustry: "Software",
    peerAvgForwardPE: null,
    peerCount: 0,
  },
  {
    symbol: "META",
    company_name: "Meta Platforms Inc.",
    exchange: "NASDAQ",
    industry: "Internet",
    last_close: 380.00,
    ath_price: null,
    ath_date: null,
    atl_price: 350.00,
    atl_date: "2024-01-05",
    change_pct: -0.8,
    volume: 15000000,
    list_type: "ATL",
    next_earnings_date: null,
    days_to_earnings: 15,
    forwardPE: null,
    pegNearTerm: null,
    pegLongTerm: null,
    nearTermGrowthPct: null,
    longTermGrowthPct: null,
    priceToSales: null,
    priceToBook: null,
    peBookHistoricalPercentile: null,
    dividendYield: null,
    sectorCategory: "growth_software",
    primaryValuationMetric: "",
    isProfitable: true,
    sector: "Technology",
    gicsIndustry: "Internet",
    peerAvgForwardPE: null,
    peerCount: 0,
  },
];

async function runTest() {
  console.log("=== Testing Spread Opportunity Scanner ===\n");
  console.log(`Test stocks: ${testStocks.map(s => s.symbol).join(", ")}\n`);
  
  // Clear cache before test
  clearSpreadOpportunityCache();
  
  try {
    const result = await scanUniverseForBestSpreadOpportunities(testStocks);
    
    console.log("\n=== Results ===\n");
    
    console.log(`Option Chain API Call Count: ${getOptionChainCallCount()}`);
    console.log(`Expected (ideally): ${testStocks.length} calls (1 per stock, not 2)\n`);
    
    console.log(`=== Best Bear Calls (${result.bestBearCalls.length}) ===`);
    result.bestBearCalls.slice(0, 10).forEach((c, i) => {
      console.log(`${i+1}. ${c.symbol} - ${c.companyName}`);
      console.log(`   Strikes: ${c.shortStrike}/${c.longStrike}, ROC: ${c.roc.toFixed(1)}%, Buffer: ${c.breakevenBufferPct.toFixed(1)}%, IV Rank: ${c.ivRank}, Score: ${c.score}`);
    });
    
    console.log(`\n=== Best Bull Puts (${result.bestBullPuts.length}) ===`);
    result.bestBullPuts.slice(0, 10).forEach((c, i) => {
      console.log(`${i+1}. ${c.symbol} - ${c.companyName}`);
      console.log(`   Strikes: ${c.shortStrike}/${c.longStrike}, ROC: ${c.roc.toFixed(1)}%, Buffer: ${c.breakevenBufferPct.toFixed(1)}%, IV Rank: ${c.ivRank}, Score: ${c.score}`);
    });
    
    console.log(`\n=== All Results with Rejection Reasons ===`);
    result.allResults.forEach((r) => {
      console.log(`${r.symbol}:`);
      if (r.bearCall) {
        console.log(`  Bear Call: ✓ Score ${r.bearCall.score}`);
      } else {
        console.log(`  Bear Call: ✗ ${r.bearCallRejectReason}`);
      }
      if (r.bullPut) {
        console.log(`  Bull Put: ✓ Score ${r.bullPut.score}`);
      } else {
        console.log(`  Bull Put: ✗ ${r.bullPutRejectReason}`);
      }
    });
    
    console.log("\n=== Test Complete ===");
    
  } catch (error) {
    console.error("Test failed:", error);
  }
}

runTest();