import {
  ComposedChart,
  Line,
  Area,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { Candle, Zone } from "@/lib/types";

export function PriceChart({
  candles,
  resistance,
  support,
  price,
}: {
  candles: Candle[];
  resistance: Zone[];
  support: Zone[];
  price: number | null;
}) {
  if (!candles.length) {
    return <p className="text-sm text-muted-foreground">無資料可繪圖（N/A）。</p>;
  }

  const data = candles.map((c) => ({ date: c.date, close: c.close }));
  const nearR = resistance.slice(0, 2);
  const nearS = support.slice(0, 2);

  return (
    <div className="w-full" data-testid="chart-price">
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="closeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            minTickGap={48}
            tickFormatter={(d) => (d as string).slice(2)}
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            width={56}
            tickFormatter={(v) => Number(v).toFixed(0)}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "hsl(var(--muted-foreground))" }}
            formatter={(v: any) => [Number(v).toFixed(2), "收盤"]}
          />
          <Area type="monotone" dataKey="close" stroke="none" fill="url(#closeFill)" />
          <Line type="monotone" dataKey="close" stroke="hsl(var(--primary))" strokeWidth={1.6} dot={false} />

          {nearR.map((z, i) => (
            <ReferenceLine
              key={`r-${i}`}
              y={z.center}
              stroke="hsl(var(--destructive))"
              strokeDasharray="4 3"
              strokeOpacity={0.7 - i * 0.2}
              label={{ value: `阻力 ${z.center}`, position: "insideTopRight", fontSize: 9, fill: "hsl(var(--destructive))" }}
            />
          ))}
          {nearS.map((z, i) => (
            <ReferenceLine
              key={`s-${i}`}
              y={z.center}
              stroke="hsl(var(--primary))"
              strokeDasharray="4 3"
              strokeOpacity={0.7 - i * 0.2}
              label={{ value: `支撐 ${z.center}`, position: "insideBottomRight", fontSize: 9, fill: "hsl(var(--primary))" }}
            />
          ))}
          {price !== null && (
            <ReferenceLine y={price} stroke="hsl(var(--foreground))" strokeOpacity={0.5} strokeWidth={1} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-4 mt-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-primary inline-block" />收盤價</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 inline-block" style={{ background: "hsl(var(--destructive))" }} />阻力中心</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-primary/60 inline-block" />支撐中心</span>
      </div>
    </div>
  );
}
