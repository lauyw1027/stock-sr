/**
 * Test script for accumulation score verification
 * Tests TTD, APTV, HONA, STWD to verify scores unchanged after corrections
 */

import { computeAccumulationScoreForTicker } from "./accumulationScore.js";

async function test() {
  const tickers = ["TTD", "APTV", "HONA", "STWD"];
  
  console.log("=== Testing Accumulation Score ===");
  console.log("Date:", new Date().toISOString());
  console.log("");
  
  for (const ticker of tickers) {
    console.log(`\n========== Testing ${ticker} ==========`);
    const result = await computeAccumulationScoreForTicker(ticker);
    console.log(`${ticker} Result:`, JSON.stringify({
      totalScore: result.totalScore,
      signals: result.signals.map(s => ({ name: s.name, points: s.points, detail: s.detail })),
      hasShortVolumeData: result.hasShortVolumeData,
      error: result.error,
    }, null, 2));
    console.log("");
    
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log("\n=== Test Complete ===");
}

test().catch(console.error);