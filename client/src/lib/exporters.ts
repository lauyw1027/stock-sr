import type { AnalyzeResult } from "./types";

// 產生可下載檔案（in-memory Blob，不使用 localStorage）
export function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function n(v: number | null): string {
  return v === null ? "N/A" : String(v);
}

export function toJSON(r: AnalyzeResult): string {
  return JSON.stringify(r, null, 2);
}

export function toCSV(r: AnalyzeResult): string {
  const rows: string[][] = [];
  rows.push(["區類型", "區間下緣", "區間中心", "區間上緣", "強度", "驗證方法", "適用週期", "備註"]);
  r.resistanceZones.forEach((z) =>
    rows.push(["阻力", n(z.low), n(z.center), n(z.high), z.strength, z.methods.join("|"), z.timeframe, z.note])
  );
  r.supportZones.forEach((z) =>
    rows.push(["支撐", n(z.low), n(z.center), n(z.high), z.strength, z.methods.join("|"), z.timeframe, z.note])
  );
  rows.push([]);
  rows.push(["指標", "數值"]);
  const i = r.indicators;
  const ind: [string, number | null][] = [
    ["MA20", i.ma20], ["MA50", i.ma50], ["MA200", i.ma200], ["ATR14", i.atr14],
    ["Pivot", i.pivot], ["R1", i.r1], ["R2", i.r2], ["S1", i.s1], ["S2", i.s2],
    ["近1月高", i.high1m], ["近1月低", i.low1m], ["近3月高", i.high3m], ["近3月低", i.low3m],
    ["近1年高", i.high1y], ["近1年低", i.low1y],
    ["Fib38.2%", i.fib382], ["Fib50%", i.fib500], ["Fib61.8%", i.fib618],
    ["CamH3", i.camH3], ["CamH4", i.camH4], ["CamH5", i.camH5],
    ["CamL3", i.camL3], ["CamL4", i.camL4], ["CamL5", i.camL5],
  ];
  ind.forEach(([k, v]) => rows.push([k, n(v)]));
  return "\uFEFF" + rows.map((row) => row.map((c) => `"${(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

export function toMarkdown(r: AnalyzeResult): string {
  const s = r.status;
  const cur = (v: number | null) => (v === null ? "N/A" : `${s.currency} ${v}`);
  const zoneRow = (z: any) =>
    `| ${cur(z.low)} ~ ${cur(z.high)} | ${z.strength} | ${z.methods.join("、")} | ${z.timeframe} | ${z.note} |`;

  return `## ${s.companyName} (${s.ticker}) 支撐阻力分析

**資料狀態**
- 公司名稱：${s.companyName}
- 股票代號：${s.ticker}
- 市場/交易所：${s.exchange}
- 目前價格：${cur(s.currentPrice)}（最後收盤價，非即時報價）
- 資料時間點：${s.dataAsOf ?? "N/A"}
- 資料週期：${s.period}
- 可用資料：${s.available.join("；")}
- 缺失資料：${s.missing.join("；")}
- 分析限制：${s.limitations.join("；")}

### 阻力區（由近到遠）
| 區間 | 強度 | 驗證方法 | 適用週期 | 備註 |
|---|---|---|---|---|
${r.resistanceZones.map(zoneRow).join("\n") || "| N/A | - | 上方無足夠資料 | - | - |"}

### 支撐區（由近到遠）
| 區間 | 強度 | 驗證方法 | 適用週期 | 備註 |
|---|---|---|---|---|
${r.supportZones.map(zoneRow).join("\n") || "| N/A | - | 下方無足夠資料 | - | - |"}

### 共振關卡
${
  r.confluenceZones.length
    ? r.confluenceZones
        .map(
          (z) =>
            `- 價格區間：${cur(z.low)} ~ ${cur(z.high)}\n  - 重疊方法：${z.methods.join("、")}\n  - 為何重要：${z.methods.length} 種方法在 1% 內重疊，關卡有效性較高`
        )
        .join("\n")
    : "- 無明確共振關卡（無方法在 1% 內重疊）"
}

### 短線情境（1-5 日）
- 偏多情境：${r.shortTerm.bull}
- 偏空情境：${r.shortTerm.bear}
- 中性情境：${r.shortTerm.neutral}

### 中線情境（1-3 個月）
- 偏多情境：${r.midTerm.bull}
- 偏空情境：${r.midTerm.bear}
- 中性情境：${r.midTerm.neutral}

### 簡要解讀
1. 當前價格最接近的支撐與阻力：${r.interpretation.nearest}
2. 哪個區域最強：${r.interpretation.strongest}
3. 最值得留意的突破/跌破條件：${r.interpretation.breakoutCondition}
4. 哪個訊號可能代表假突破：${r.interpretation.fakeoutSignal}
5. 本分析的主要限制：${r.interpretation.limitation}

### 風險聲明
以上內容僅為技術分析與教育用途，非投資建議。

---
*資料來源：Yahoo Finance（日線 OHLCV）。產生時間：${new Date().toISOString()}*
`;
}
