/**
 * 日元 Carry Trade 平倉風險監控 - 頁面元件
 */

import { useCarryTradeRisk } from '../hooks/useCarryTradeRisk';
import { RiskLevel } from '../types/carryTradeRisk';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Layout } from '@/components/Layout';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { AlertTriangle, TrendingUp, TrendingDown, Activity, DollarSign, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// 燈號顏色配置
// ============================================================================

const RISK_COLORS: Record<RiskLevel, string> = {
  '低': '#437a22',
  '中': '#d19900',
  '高': '#a13544',
};

const RISK_BG_COLORS: Record<RiskLevel, string> = {
  '低': 'rgba(67, 122, 34, 0.15)',
  '中': 'rgba(209, 153, 0, 0.15)',
  '高': 'rgba(161, 53, 68, 0.15)',
};

// ============================================================================
// 子元件：風險分數顯示
// ============================================================================

function RiskScoreDisplay({ 
  score, 
  level 
}: { 
  score: number; 
  level: RiskLevel;
}) {
  const color = RISK_COLORS[level];
  
  return (
    <div className="relative w-32 h-32">
      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
        {/* 背景圓環 */}
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          className="text-muted/20"
        />
        {/* 進度圓環 */}
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * 283} 283`}
          className="transition-all duration-1000"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold" style={{ color }}>
          {score}
        </span>
        <span className="text-xs text-muted-foreground">/100</span>
      </div>
    </div>
  );
}

// ============================================================================
// 子元件：指標說明文字
// ============================================================================

function MetricExplanation({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 p-3 rounded-md bg-muted/30 text-xs text-muted-foreground space-y-1">
      <div className="font-medium text-foreground">{title}</div>
      {children}
    </div>
  );
}
// ============================================================================

interface MetricCardProps {
  title: string;
  value: string | number | null;
  subtitle?: string;
  icon: React.ReactNode;
  change?: number | null;
}

function MetricCard({ title, value, subtitle, icon, change }: MetricCardProps) {
  const isPositive = change !== null && change !== undefined && change > 0;
  const isNegative = change !== null && change !== undefined && change < 0;
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <span className="text-sm font-medium">{title}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {value !== null ? value : <span className="text-muted-foreground text-lg">暫時無法取得</span>}
        </div>
        {change !== null && change !== undefined && (
          <div className={cn(
            "text-sm mt-1 flex items-center gap-1",
            isPositive ? "text-red-500" : isNegative ? "text-green-500" : "text-muted-foreground"
          )}>
            {isPositive ? <TrendingUp className="w-3 h-3" /> : isNegative ? <TrendingDown className="w-3 h-3" /> : null}
            {isPositive ? '+' : ''}{change.toFixed(2)}%
          </div>
        )}
        {subtitle && <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// 主頁面元件
// ============================================================================

export default function CarryTradeRiskPage() {
  const { data, loading, error, refetch } = useCarryTradeRisk();

  if (loading) {
    return (
      <Layout title="日元 Carry Trade 平倉風險監控" subtitle="系統性風險預警框架">
        <div className="container mx-auto py-8">
          <div className="flex items-center justify-center h-64">
            <div className="text-muted-foreground">加载中...</div>
          </div>
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout title="日元 Carry Trade 平倉風險監控" subtitle="系統性風險預警框架">
        <div className="container mx-auto py-8">
          <Card className="border-destructive">
            <CardHeader>
              <CardTitle className="text-destructive">错误</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-destructive">{error.message}</p>
              <button
                onClick={refetch}
                className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md"
              >
                重试
              </button>
            </CardContent>
          </Card>
        </div>
      </Layout>
    );
  }

  const score = data?.score;
  const level = score?.level || '低';
  const color = RISK_COLORS[level];
  const bgColor = RISK_BG_COLORS[level];

  // 準備圖表資料
  const chartData = data?.cftc?.history?.map((item) => ({
    date: item.date.slice(5), // MM-DD 格式
    net: item.net,
  })) || [];

  return (
    <Layout title="日元 Carry Trade 平倉風險監控" subtitle="系統性風險預警框架">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        {/* 頁面標題 */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">日元 Carry Trade 平倉風險監控</h1>
            <p className="text-sm text-muted-foreground mt-1">
              追蹤 USD/JPY、VIX 與 CFTC 投機性倉位，評估日元利差交易平倉風險
            </p>
          </div>
          {data?.lastUpdated && (
            <div className="text-xs text-muted-foreground">
              最後更新：{new Date(data.lastUpdated).toLocaleString('zh-TW')}
            </div>
          )}
        </div>

        {/* 風險總分顯示 */}
        {score && (
          <Card className="overflow-hidden">
            <div className="p-6" style={{ backgroundColor: bgColor }}>
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-6">
                  <RiskScoreDisplay score={score.total} level={level} />
                  <div>
                    <div className="text-sm text-muted-foreground">風險等級</div>
                    <div className="flex items-center gap-2 mt-1">
                      <AlertTriangle className="w-5 h-5" style={{ color }} />
                      <span className="text-2xl font-bold" style={{ color }}>
                        {level}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-2">
                      {level === '低' ? '市場相對穩定，Carry Trade 風險較低' : 
                       level === '中' ? '需關注變化，建議審慎評估' : 
                       '風險偏高，可能面臨平倉壓力'}
                    </div>
                  </div>
                </div>
                <div className="flex gap-6 text-sm">
                  <div className="text-center">
                    <div className="text-muted-foreground">USD/JPY 速度</div>
                    <div className="font-bold">{score.usdjpySpeed.toFixed(1)}</div>
                    <div className="text-xs text-muted-foreground">/40</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">VIX 水平</div>
                    <div className="font-bold">{score.vixLevel.toFixed(1)}</div>
                    <div className="text-xs text-muted-foreground">/30</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">CFTC 倉位</div>
                    <div className="font-bold">{score.cftcPositioning.toFixed(1)}</div>
                    <div className="text-xs text-muted-foreground">/30</div>
                  </div>
                </div>
              </div>
            </div>
            {/* 這是什麼？Accordion 說明 */}
            <Accordion type="single" collapsible className="border-t">
              <AccordionItem value="what-is-this" className="border-0">
                <AccordionTrigger className="px-6 py-3 text-sm text-muted-foreground hover:no-underline hover:text-foreground">
                  <div className="flex items-center gap-2">
                    <Info className="w-4 h-4" />
                    這是什麼？
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-4 text-sm text-muted-foreground space-y-2">
                  <p>
                    這個分數（0-100）告訴你：全球投資人是否正大量借入低利率的日元、換成美元去買美股等資產（這叫「日元套利交易」）。分數越高，代表這個借貸鏈一旦被打斷，可能引發資產被迫拋售的風險越高——類似骨牌效應。
                  </p>
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    <div className="text-center p-2 rounded bg-[#437a22]/10">
                      <div className="w-2 h-2 rounded-full bg-[#437a22] mx-auto mb-1"></div>
                      <div className="text-xs font-medium">綠色（0-29）</div>
                      <div className="text-xs">借貸鏈穩定，短期內平倉風險較低</div>
                    </div>
                    <div className="text-center p-2 rounded bg-[#d19900]/10">
                      <div className="w-2 h-2 rounded-full bg-[#d19900] mx-auto mb-1"></div>
                      <div className="text-xs font-medium">黃色（30-59）</div>
                      <div className="text-xs">開始出現緊張訊號，建議留意後續變化</div>
                    </div>
                    <div className="text-center p-2 rounded bg-[#a13544]/10">
                      <div className="w-2 h-2 rounded-full bg-[#a13544] mx-auto mb-1"></div>
                      <div className="text-xs font-medium">紅色（60-100）</div>
                      <div className="text-xs">借貸鏈壓力大，隨時可能觸發連鎖拋售</div>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Card>
        )}

        {/* 關鍵指標卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <MetricCard
              title="USD/JPY"
              value={data?.usdjpy?.price !== null ? data?.usdjpy?.price?.toFixed(2) : null}
              subtitle="美元兌日元匯率"
              icon={<DollarSign className="w-4 h-4" />}
              change={data?.usdjpy?.change2dPct ?? null}
            />
            <MetricExplanation title="美元兌日元匯率">
              <p>簡單說，這個數字下跌，代表日元變貴了（升值）。</p>
              <p>為什麼要看這個？借日元的人最怕日元突然變貴，因為那樣還債成本會暴增，逼他們趕快賣掉手中的美股或其他資產去換日元還債。這個數字如果在短時間內大幅下跌，就是警訊。</p>
            </MetricExplanation>
          </div>
          <div>
            <MetricCard
              title="VIX 指數"
              value={data?.vix !== null ? data?.vix?.toFixed(2) : null}
              subtitle="波動率指數（恐慌指數）"
              icon={<Activity className="w-4 h-4" />}
            />
            <MetricExplanation title="VIX 指數（市場恐慌指標）">
              <p>簡單說，這個數字代表華爾街投資人現在有多緊張，數字越高代表大家越害怕股市會有大波動。</p>
              <p>為什麼要看這個？如果日元套利交易真的開始平倉，通常會伴隨全球股市一起緊張，VIX 會跟著往上衝。VIX 維持在低點時，代表市場目前還算平靜。</p>
            </MetricExplanation>
          </div>
          <div>
            <MetricCard
              title="CFTC 淨倉位"
              value={data?.cftc?.netNoncomm !== null ? 
                (data?.cftc?.netNoncomm !== undefined ? 
                  (data.cftc.netNoncomm / 1000).toFixed(1) + 'K' : null) : null}
              subtitle={data?.cftc?.netNoncomm !== null && data?.cftc?.netNoncomm !== undefined 
                ? (data.cftc.netNoncomm >= 0 ? "淨多頭" : "淨空頭")
                : "日元期貨投機性淨倉位"}
              icon={<TrendingUp className="w-4 h-4" />}
            />
            <MetricExplanation title="投機客的日元倉位（正負代表方向）">
              <p>簡單說，這個數字告訴你「有多少人在賭日元會繼續貶值」。</p>
              <p>負數 = 大家都在賭日元貶值（放空日元）</p>
              <p>正數 = 大家開始看好日元升值（做多日元）</p>
              <p>為什麼要看這個？當負數很大時，代表「賭日元貶值」的人已經非常多、非常擁擠。就像擠在同一邊的船，一旦風向轉變，這些人會搶著同時往反方向跑，容易引發劇烈的價格波動。這個數字本身不能預測日元何時會轉向，但數字越極端，代表未來一旦反轉，力道可能越猛烈。</p>
            </MetricExplanation>
          </div>
        </div>

        {/* CFTC 歷史圖表 */}
        {chartData.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">CFTC 投機性淨倉位歷史（12週）</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="opacity-20" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fontSize: 12 }}
                      stroke="currentColor"
                      className="text-muted-foreground"
                    />
                    <YAxis 
                      tick={{ fontSize: 12 }}
                      stroke="currentColor"
                      className="text-muted-foreground"
                      tickFormatter={(value) => `${(value / 1000).toFixed(0)}K`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                      }}
                      formatter={(value: number) => [`${(value / 1000).toFixed(1)}K`, '淨倉位']}
                      labelStyle={{ color: 'hsl(var(--foreground))' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="net"
                      stroke={color}
                      strokeWidth={2}
                      dot={{ fill: color, strokeWidth: 2 }}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground mt-4 text-center">
                資料來源：CFTC COT 報告（每週二公佈上週數據）
              </p>
            </CardContent>
          </Card>
        )}

        {/* 重要提醒 */}
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              ⚠️ 重要提醒
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>這個工具是用來輔助判斷市場氛圍，不是用來預測價格方向。</p>
            <p>歷史上（例如2024年8月）日元套利平倉曾引發全球股市、加密貨幣同步大跌，但這類事件通常需要多個訊號同時出現（日元急升 + VIX 飆升 + 擁擠倉位鬆動）才算是比較可信的警示，單看一個指標容易誤判。</p>
            <p>本工具數據每15-30分鐘更新，僅供參考，不構成投資建議。</p>
          </CardContent>
        </Card>

        {/* 技術說明 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">風險評分說明</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground">USD/JPY 速度 (40分)</span>
              <span>：日元短期快速升值會觸發 carry trade 平倉，2日內貶值幅度越大分數越高。</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground">VIX 水平 (30分)</span>
              <span>：VIX 低於 12 為低風險，35 以上為高風險。VIX 飆升表示市場恐慌，可能引發平倉。</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground">CFTC 倉位擁擠度 (30分)</span>
              <span>：淨倉位越接近歷史低點（淨空頭越多），市場越擁擠，平倉風險越大。</span>
            </div>
            <div className="mt-4 pt-4 border-t">
              <div className="font-medium text-foreground mb-2">風險等級定義</div>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="w-3 h-3 rounded-full bg-[#437a22] mx-auto mb-1"></div>
                  <span className="text-foreground">低 (0-29)</span>
                </div>
                <div>
                  <div className="w-3 h-3 rounded-full bg-[#d19900] mx-auto mb-1"></div>
                  <span className="text-foreground">中 (30-59)</span>
                </div>
                <div>
                  <div className="w-3 h-3 rounded-full bg-[#a13544] mx-auto mb-1"></div>
                  <span className="text-foreground">高 (60-100)</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}