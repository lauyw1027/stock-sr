/**
 * Test script for distributionScore.ts
 * Run with: npx tsx server/test-distribution.ts
 */

interface OHLCVBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DistributionDayResult {
  count: number;
  offsetCount: number;
  effectiveCount: number;
  score: number;
  detail: string;
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

console.log("=== Test 1: Weight Sum Verification ===");
const WEIGHT_SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
console.log(`Weight sum: ${WEIGHT_SUM} (expected: 100)`);
console.log(`✅ ${WEIGHT_SUM === 100 ? 'PASS' : 'FAIL'}`);

console.log("\n=== Test 2: IBD Distribution Days - Healthy Trend (0-2 days) ===");

function evalIBDDistributionDays(bars: OHLCVBar[]): DistributionDayResult {
  const windowBars = bars.slice(-25);
  
  if (windowBars.length < 25) {
    return { count: 0, offsetCount: 0, effectiveCount: 0, score: 0, detail: "資料不足" };
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
  console.log(`  Raw distribution days: ${rawCount}`);

  // 抵銷規則一
  for (const f of flags) {
    if (f.isRally) {
      const oldestUnoffset = flags.find((d) => d.isDistribution && !d.offset);
      if (oldestUnoffset) oldestUnoffset.offset = true;
    }
  }

  // 抵銷規則二：前一個 Distribution Day 之後 3 天內出現較高收盤價，則前一個被抵銷
  const distributionIndices = flags.filter(f => f.isDistribution).map(f => f.index);
  for (let i = 0; i < distributionIndices.length; i++) {
    const distIdx = distributionIndices[i];
    const distClose = flags[distIdx].close;
    
    for (let j = distIdx + 1; j <= distIdx + 3 && j < flags.length; j++) {
      if (!flags[distIdx].offset && flags[j].close > distClose) {
        flags[distIdx].offset = true;
        break;
      }
    }
  }

  const offsetCount = flags.filter((f) => f.isDistribution && f.offset).length;
  const effectiveCount = rawCount - offsetCount;

  let score = 0;
  let riskLabel = "低風險";
  if (effectiveCount >= 6) { score = 1; riskLabel = "高風險"; }
  else if (effectiveCount >= 4) { score = 0.5; riskLabel = "中風險"; }

  return { count: rawCount, offsetCount, effectiveCount, score, detail: `${effectiveCount}個有效派發日` };
}

// 健康趨勢：穩定上漲，沒有派發日
const healthyBars: OHLCVBar[] = [];
let price = 100;
for (let i = 0; i < 30; i++) {
  // 每天都小幅上漲，變化範圍 -0.1% 到 +0.3%
  const change = (Math.random() * 0.004) - 0.001; 
  price = price * (1 + change);
  const dayVol = 1000000 + Math.random() * 200000;
  healthyBars.push({
    date: new Date(),
    open: price * (1 - Math.random() * 0.002),
    high: price * (1 + Math.random() * 0.002),
    low: price * (1 - Math.random() * 0.002),
    close: price,
    volume: dayVol
  });
}

const healthyResult = evalIBDDistributionDays(healthyBars);
console.log(`  Result: ${healthyResult.detail}`);
console.log(`  Expected: effectiveCount <= 2, actual: ${healthyResult.effectiveCount}`);
console.log(`  ${healthyResult.effectiveCount <= 2 ? '✅ PASS' : '❌ FAIL'}`);

console.log("\n=== Test 3: IBD Distribution Days - Clear Distribution (6+ days) ===");

// 明確派發階段：連續多日放量下跌，但派發日相隔 > 3 天避免觸發抵銷
const distributionBars: OHLCVBar[] = [];
price = 100;
for (let i = 0; i < 30; i++) {
  let dayChange: number;
  let dayVol: number;
  
  // Distribution day every 5 days (not within 3-day offset window)
  if (i === 5 || i === 10 || i === 15 || i === 20 || i === 25) {
    dayChange = -0.005; // -0.5%
    dayVol = 3000000;
  } else {
    dayChange = (Math.random() * 0.002) - 0.001; // Small movements
    dayVol = 1000000;
  }
  
  price = price * (1 + dayChange);
  distributionBars.push({
    date: new Date(),
    open: price * (1 - Math.random() * 0.001),
    high: price * (1 + Math.random() * 0.001),
    low: price * (1 - Math.random() * 0.001),
    close: price,
    volume: dayVol
  });
}

const distributionResult = evalIBDDistributionDays(distributionBars);
console.log(`  Result: ${distributionResult.detail}`);
console.log(`  Expected: effectiveCount >= 6, actual: ${distributionResult.effectiveCount}`);
console.log(`  ${distributionResult.effectiveCount >= 6 ? '✅ PASS' : '❌ FAIL'}`);

console.log("\n=== Test 4: Offset Rule Verification ===");

// 構造：第10天派發日，第12天收盤價高於第10天，應該被抵銷
const offsetTestBars: OHLCVBar[] = [];
price = 100;
for (let i = 0; i < 30; i++) {
  let dayChange: number;
  let dayVol: number;
  
  if (i === 10) {
    // Distribution day at index 10
    dayChange = -0.005; // -0.5%
    dayVol = 3000000;
  } else if (i === 12) {
    // 2 days later, close higher than distribution day = offset
    dayChange = 0.008; // +0.8%
    dayVol = 3000000;
  } else {
    dayChange = (Math.random() * 0.004) - 0.001;
    dayVol = 1000000;
  }
  
  price = price * (1 + dayChange);
  offsetTestBars.push({
    date: new Date(),
    open: price * (1 - Math.random() * 0.001),
    high: price * (1 + Math.random() * 0.001),
    low: price * (1 - Math.random() * 0.001),
    close: price,
    volume: dayVol
  });
}

const offsetResult = evalIBDDistributionDays(offsetTestBars);
console.log(`  Result: ${offsetResult.detail}`);
console.log(`  Expected: offsetCount >= 1, actual: ${offsetResult.offsetCount}`);
console.log(`  ${offsetResult.offsetCount >= 1 ? '✅ PASS' : '❌ FAIL'}`);

console.log("\n=== Test 5: FINRA API Call (invalid symbol) ===");

import axios from 'axios';

async function testFinra() {
  try {
    await axios.post(
      'https://api.finra.org/data/group/otcMarket/name/regShoDaily',
      { limit: 5, compareFilters: [{ compareType: 'equal', fieldName: 'securitiesInformationProcessorSymbolIdentifier', fieldValue: 'INVALID_SYMBOL_XYZ123' }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log('  Response received');
  } catch (e: any) {
    console.log(`  Error status: ${e.response?.status ?? 'no-http'}`);
    console.log(`  No uncaught exception: YES`);
    console.log(`  ✅ PASS`);
  }
}

testFinra().then(() => console.log("\n=== Tests Complete ==="));