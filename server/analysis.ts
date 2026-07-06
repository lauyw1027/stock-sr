/**
 * analysis.ts — 支撐/阻力技術分析計算引擎
 *
 * 所有指標均由 OHLCV 資料計算，絕不捏造。若資料不足則回傳 N/A 並附原因。
 *
 * ── 公式參考 (Formulas) ────────────────────────────────────────────────
 *  MA(n)        = 最近 n 根收盤價的算術平均
 *  TR (True Range) = max(High-Low, |High-PrevClose|, |Low-PrevClose|)
 *  ATR14        = 最近 14 根 TR 的 Wilder 平滑平均 (RMA)
 *  Pivot (經典) = (H + L + C) / 3      使用「最後一個完整週期」的 H/L/C
 *  R1 = 2*Pivot - L ；  S1 = 2*Pivot - H
 *  R2 = Pivot + (H - L) ；  S2 = Pivot - (H - L)
 *  Camarilla:   H3 = C + (H-L)*1.1/4 ；  H4 = C + (H-L)*1.1/2 ；  H5 = C + (H-L)*1.1/1.5? 
 *               （本實作 H5 使用 (H/L)*C 收盤突破式；見下方註解）
 *               L3 = C - (H-L)*1.1/4 ；  L4 = C - (H-L)*1.1/2
 *  Fibonacci 回撤 (以區間高低 Hi/Lo 為基準):
 *               level(p) = Hi - (Hi - Lo) * p ，p ∈ {0.382, 0.5, 0.618}
 *  區間半寬 zoneHalfWidth = max(ATR14 * 0.2, price * 0.004)
 *  共振 (Confluence): 不同方法的價位彼此在 1% 內重疊即標記為共振
 * ───────────────────────────────────────────────────────────────────────
 */

export interface Candle {
  date: string; // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LevelHit {
  method: string; // 方法名稱（中文）
  price: number;
}

export interface Zone {
  center: number;
  low: number;
  high: number;
  methods: string[]; // 貢獻此區間的方法
  strength: "強" | "中" | "弱";
  timeframe: string; // 適用週期
  isConfluence: boolean;
  note: string;
}

export interface Indicators {
  ma20: number | null;
  ma50: number | null;
  ma200: number | null;
  atr14: number | null;
  pivot: number | null;
  r1: number | null;
  r2: number | null;
  s1: number | null;
  s2: number | null;
  high1m: number | null;
  low1m: number | null;
  high3m: number | null;
  low3m: number | null;
  high1y: number | null;
  low1y: number | null;
  fib382: number | null;
  fib500: number | null;
  fib618: number | null;
  fibHi: number | null;
  fibLo: number | null;
  camH3: number | null;
  camH4: number | null;
  camH5: number | null;
  camL3: number | null;
  camL4: number | null;
  camL5: number | null;
  consolidation: ConsolidationZone[];
  turningZones: number[]; // 歷史轉折價位
  zoneHalfWidth: number | null;
}

export interface ConsolidationZone {
  low: number;
  high: number;
  startDate: string;
  endDate: string;
  bars: number;
}

export interface AnalyzeResult {
  status: {
    companyName: string;
    ticker: string;
    exchange: string;
    currentPrice: number | null;
    currency: string;
    dataAsOf: string | null; // 資料時間點（最後一根 K 線日期）
    period: string;
    available: string[];
    missing: string[];
    limitations: string[];
  };
  indicators: Indicators;
  resistanceZones: Zone[];
  supportZones: Zone[];
  confluenceZones: Zone[];
  candles: Candle[]; // 供前端畫圖
  interpretation: {
    nearest: string;
    strongest: string;
    breakoutCondition: string;
    fakeoutSignal: string;
    limitation: string;
  };
  shortTerm: { bull: string; bear: string; neutral: string };
  midTerm: { bull: string; bear: string; neutral: string };
}

function round(v: number | null, d = 2): number | null {
  if (v === null || !isFinite(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const slice = values.slice(values.length - n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

/** Wilder ATR */
function atr(candles: Candle[], n: number): number | null {
  if (candles.length < n + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // 初始 ATR = 前 n 個 TR 平均，之後 Wilder 平滑
  let atrVal = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < tr.length; i++) {
    atrVal = (atrVal * (n - 1) + tr[i]) / n;
  }
  return atrVal;
}

function highLow(candles: Candle[], bars: number): { high: number | null; low: number | null } {
  if (candles.length === 0) return { high: null, low: null };
  const slice = candles.slice(Math.max(0, candles.length - bars));
  if (slice.length === 0) return { high: null, low: null };
  return {
    high: Math.max(...slice.map((c) => c.high)),
    low: Math.min(...slice.map((c) => c.low)),
  };
}

/**
 * 偵測盤整/平台區間：以滑動視窗尋找價格區間收斂 (range/price < 8%) 的連續區段
 */
function detectConsolidation(candles: Candle[]): ConsolidationZone[] {
  const zones: ConsolidationZone[] = [];
  const win = 15; // 約 3 週交易日
  if (candles.length < win) return zones;
  let i = candles.length - Math.min(candles.length, 180); // 只看最近約 6 個月
  if (i < 0) i = 0;
  while (i + win <= candles.length) {
    const slice = candles.slice(i, i + win);
    const hi = Math.max(...slice.map((c) => c.high));
    const lo = Math.min(...slice.map((c) => c.low));
    const mid = (hi + lo) / 2;
    const rangePct = mid > 0 ? (hi - lo) / mid : 1;
    if (rangePct < 0.08) {
      // 嘗試向右延伸
      let end = i + win;
      while (end < candles.length) {
        const nhi = Math.max(hi, candles[end].high);
        const nlo = Math.min(lo, candles[end].low);
        const nmid = (nhi + nlo) / 2;
        if ((nhi - nlo) / nmid < 0.09) end++;
        else break;
      }
      const zslice = candles.slice(i, end);
      const zhi = Math.max(...zslice.map((c) => c.high));
      const zlo = Math.min(...zslice.map((c) => c.low));
      zones.push({
        low: round(zlo)!,
        high: round(zhi)!,
        startDate: zslice[0].date,
        endDate: zslice[zslice.length - 1].date,
        bars: zslice.length,
      });
      i = end;
    } else {
      i += 5;
    }
  }
  // 只保留最近最多 3 個
  return zones.slice(-3);
}

/**
 * 歷史轉折點：擺動高/低 (swing high/low)，左右各 5 根為極值
 */
function detectTurningZones(candles: Candle[]): number[] {
  const k = 5;
  const points: number[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const win = candles.slice(i - k, i + k + 1);
    const c = candles[i];
    if (c.high === Math.max(...win.map((x) => x.high))) points.push(c.high);
    if (c.low === Math.min(...win.map((x) => x.low))) points.push(c.low);
  }
  // 只保留最近 200 根內的轉折，並去重相近值
  return points;
}

export function computeIndicators(candles: Candle[]): Indicators {
  const closes = candles.map((c) => c.close);
  const price = closes.length ? closes[closes.length - 1] : null;

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const atr14 = atr(candles, 14);

  // Pivot：使用「最後一根 K 線」的 H/L/C（日內樞紐點；以最後完整交易日計算）
  const last = candles[candles.length - 1];
  let pivot: number | null = null,
    r1: number | null = null,
    r2: number | null = null,
    s1: number | null = null,
    s2: number | null = null;
  let camH3: number | null = null,
    camH4: number | null = null,
    camH5: number | null = null,
    camL3: number | null = null,
    camL4: number | null = null,
    camL5: number | null = null;
  if (last) {
    const H = last.high,
      L = last.low,
      C = last.close;
    pivot = (H + L + C) / 3;
    r1 = 2 * pivot - L;
    s1 = 2 * pivot - H;
    r2 = pivot + (H - L);
    s2 = pivot - (H - L);
    const range = H - L;
    camH3 = C + (range * 1.1) / 4;
    camH4 = C + (range * 1.1) / 2;
    camH5 = L !== 0 ? (H / L) * C : C + range * 1.1; // 突破式 H5
    camL3 = C - (range * 1.1) / 4;
    camL4 = C - (range * 1.1) / 2;
    camL5 = camH5 !== null ? C - (camH5 - C) : C - range * 1.1;
  }

  const hl1m = highLow(candles, 21);
  const hl3m = highLow(candles, 63);
  const hl1y = highLow(candles, 252);

  // Fibonacci：以最近 1 年高低為基準
  let fib382: number | null = null,
    fib500: number | null = null,
    fib618: number | null = null;
  const fibHi = hl1y.high,
    fibLo = hl1y.low;
  if (fibHi !== null && fibLo !== null && fibHi > fibLo) {
    fib382 = fibHi - (fibHi - fibLo) * 0.382;
    fib500 = fibHi - (fibHi - fibLo) * 0.5;
    fib618 = fibHi - (fibHi - fibLo) * 0.618;
  }

  const zoneHalfWidth =
    price !== null && atr14 !== null
      ? Math.max(atr14 * 0.2, price * 0.004)
      : price !== null
      ? price * 0.004
      : null;

  return {
    ma20: round(ma20),
    ma50: round(ma50),
    ma200: round(ma200),
    atr14: round(atr14),
    pivot: round(pivot),
    r1: round(r1),
    r2: round(r2),
    s1: round(s1),
    s2: round(s2),
    high1m: round(hl1m.high),
    low1m: round(hl1m.low),
    high3m: round(hl3m.high),
    low3m: round(hl3m.low),
    high1y: round(hl1y.high),
    low1y: round(hl1y.low),
    fib382: round(fib382),
    fib500: round(fib500),
    fib618: round(fib618),
    fibHi: round(fibHi),
    fibLo: round(fibLo),
    camH3: round(camH3),
    camH4: round(camH4),
    camH5: round(camH5),
    camL3: round(camL3),
    camL4: round(camL4),
    camL5: round(camL5),
    consolidation: detectConsolidation(candles),
    turningZones: detectTurningZones(candles).map((v) => round(v)!),
    zoneHalfWidth: round(zoneHalfWidth, 3),
  };
}

/**
 * 將各方法產生的價位分組為支撐/阻力區間，並偵測共振（1% 內重疊）。
 */
export function buildZones(
  ind: Indicators,
  price: number
): { support: Zone[]; resistance: Zone[]; confluence: Zone[] } {
  const halfWidth = ind.zoneHalfWidth ?? price * 0.004;

  // 收集所有候選價位（含方法名稱 + 適用週期 + 基礎強度權重）
  interface Cand extends LevelHit {
    timeframe: string;
    weight: number;
  }
  const cands: Cand[] = [];
  const push = (method: string, p: number | null, timeframe: string, weight: number) => {
    if (p !== null && isFinite(p) && p > 0) cands.push({ method, price: p, timeframe, weight });
  };

  push("MA20", ind.ma20, "短線", 2);
  push("MA50", ind.ma50, "中線", 2);
  push("MA200", ind.ma200, "中長線", 3);
  push("樞紐點 Pivot", ind.pivot, "短線", 1);
  push("R1", ind.r1, "短線", 1);
  push("R2", ind.r2, "短線", 1);
  push("S1", ind.s1, "短線", 1);
  push("S2", ind.s2, "短線", 1);
  push("近1月高", ind.high1m, "短線", 2);
  push("近1月低", ind.low1m, "短線", 2);
  push("近3月高", ind.high3m, "中線", 2);
  push("近3月低", ind.low3m, "中線", 2);
  push("近1年高", ind.high1y, "中長線", 3);
  push("近1年低", ind.low1y, "中長線", 3);
  push("Fib 38.2%", ind.fib382, "中線", 2);
  push("Fib 50%", ind.fib500, "中線", 2);
  push("Fib 61.8%", ind.fib618, "中線", 2);
  push("Camarilla H3", ind.camH3, "短線", 1);
  push("Camarilla H4", ind.camH4, "短線", 1);
  push("Camarilla L3", ind.camL3, "短線", 1);
  push("Camarilla L4", ind.camL4, "短線", 1);
  // 盤整平台上下緣
  ind.consolidation.forEach((z, i) => {
    push(`盤整平台上緣#${i + 1}`, z.high, "中線", 2);
    push(`盤整平台下緣#${i + 1}`, z.low, "中線", 2);
  });
  // 歷史轉折區
  ind.turningZones.forEach((p) => push("歷史轉折", p, "中線", 1));

  // 分組：以 1% 距離做群聚
  const sorted = [...cands].sort((a, b) => a.price - b.price);
  const clusters: Cand[][] = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(c.price - last[last.length - 1].price) / c.price <= 0.01) {
      last.push(c);
    } else {
      clusters.push([c]);
    }
  }

  const zones: Zone[] = clusters.map((cluster) => {
    const center = cluster.reduce((a, b) => a + b.price, 0) / cluster.length;
    const methods = Array.from(new Set(cluster.map((c) => c.method)));
    const totalWeight = cluster.reduce((a, b) => a + b.weight, 0);
    const isConfluence = methods.length >= 2;
    // 強度：依方法數與權重
    let strength: Zone["strength"] = "弱";
    if (methods.length >= 3 || totalWeight >= 6) strength = "強";
    else if (methods.length === 2 || totalWeight >= 3) strength = "中";
    // 適用週期：取出現最多的
    const tfCount: Record<string, number> = {};
    cluster.forEach((c) => (tfCount[c.timeframe] = (tfCount[c.timeframe] || 0) + 1));
    const timeframe = Object.entries(tfCount).sort((a, b) => b[1] - a[1])[0][0];
    const low = center - halfWidth;
    const high = center + halfWidth;
    return {
      center: round(center)!,
      low: round(low)!,
      high: round(high)!,
      methods,
      strength,
      timeframe,
      isConfluence,
      note: isConfluence ? `${methods.length} 種方法重疊` : "單一方法",
    };
  });

  const resistance = zones
    .filter((z) => z.center > price)
    .sort((a, b) => a.center - b.center); // 由近到遠
  const support = zones
    .filter((z) => z.center <= price)
    .sort((a, b) => b.center - a.center); // 由近到遠（價格往下）
  const confluence = zones.filter((z) => z.isConfluence).sort((a, b) => b.methods.length - a.methods.length);

  return { support, resistance, confluence };
}

function fmt(v: number | null): string {
  return v === null ? "N/A" : v.toFixed(2);
}

/**
 * 產生情境與解讀文字（基於已計算的區間，不預測、不捏造價格）
 */
export function buildNarrative(
  ind: Indicators,
  price: number,
  support: Zone[],
  resistance: Zone[],
  currency: string
): Pick<AnalyzeResult, "interpretation" | "shortTerm" | "midTerm"> {
  const nearR = resistance[0];
  const nearS = support[0];
  const strongest = [...support, ...resistance].sort((a, b) => {
    const s = { 強: 3, 中: 2, 弱: 1 } as const;
    return s[b.strength] - s[a.strength] || b.methods.length - a.methods.length;
  })[0];

  const cur = (v: number | null) => (v === null ? "N/A" : `${currency}${v.toFixed(2)}`);

  const interpretation = {
    nearest: `目前參考價 ${cur(price)}。最接近的阻力區為 ${
      nearR ? `${cur(nearR.low)} ~ ${cur(nearR.high)}（${nearR.methods.join("、")}）` : "N/A（上方無足夠資料形成阻力）"
    }；最接近的支撐區為 ${
      nearS ? `${cur(nearS.low)} ~ ${cur(nearS.high)}（${nearS.methods.join("、")}）` : "N/A（下方無足夠資料形成支撐）"
    }。`,
    strongest: strongest
      ? `目前最強的關卡為 ${cur(strongest.low)} ~ ${cur(strongest.high)}（強度：${strongest.strength}，${strongest.methods.join(
          "、"
        )}），因為有較多方法在此重疊。`
      : "N/A：資料不足以判斷最強關卡。",
    breakoutCondition: nearR
      ? `若收盤價站上並持穩於 ${cur(nearR.high)} 之上（最好伴隨放量），可視為向上突破，下一個目標為次一阻力區。`
      : "N/A：缺乏明確上方阻力，無法定義突破條件。",
    fakeoutSignal: nearR
      ? `若盤中曾觸及 ${cur(nearR.high)} 上方但收盤又跌回區間內、或長上影線且無量，可能為假突破；跌破 ${
          nearS ? cur(nearS.low) : "近端支撐"
        } 則相反為假跌破。`
      : "N/A：資料不足以判斷假突破訊號。",
    limitation:
      "本分析僅使用日線 OHLCV，未使用逐筆成交量分佈（volume profile），亦不含即時報價；樞紐點以最後一個交易日計算，屬短線性質。所有結論以最後收盤價為參考基準。",
  };

  const ma20 = ind.ma20,
    ma50 = ind.ma50;
  const trendShort =
    ma20 !== null && price > ma20 ? "價格位於 MA20 之上，短線偏多結構" : ma20 !== null ? "價格位於 MA20 之下，短線偏空結構" : "MA20 資料不足";
  const trendMid =
    ma50 !== null && ind.ma200 !== null
      ? price > ma50 && price > ind.ma200
        ? "價格位於 MA50 與 MA200 之上，中期多頭排列"
        : price < ma50 && price < ind.ma200
        ? "價格位於 MA50 與 MA200 之下，中期空頭排列"
        : "均線糾結，中期方向不明"
      : "中期均線資料不足";

  const shortTerm = {
    bull: `若守穩 ${nearS ? cur(nearS.low) : "近端支撐"} 並帶量挑戰 ${
      nearR ? cur(nearR.low) : "近端阻力"
    }，1-5 日內有機會測試上方阻力。（現況：${trendShort}）`,
    bear: `若跌破 ${nearS ? cur(nearS.low) : "近端支撐"} 且無法快速收復，短線可能下探次一支撐區。`,
    neutral: `若在 ${nearS ? cur(nearS.center) : "近端支撐"} 與 ${
      nearR ? cur(nearR.center) : "近端阻力"
    } 之間震盪，則維持區間整理，等待方向表態。`,
  };

  const midTerm = {
    bull: `若站穩 MA50/MA200 並突破 ${
      ind.high3m !== null ? cur(ind.high3m) : "近3月高"
    }，1-3 個月中期結構轉強。（現況：${trendMid}）`,
    bear: `若跌破 MA200 或 ${ind.low3m !== null ? cur(ind.low3m) : "近3月低"}，中期趨勢轉弱，須留意下方年線區支撐。`,
    neutral: `若在 MA50 與 MA200 區間內反覆，中期以區間操作看待，等待均線重新發散。`,
  };

  return { interpretation, shortTerm, midTerm };
}
