/**
 * AI 基建系統性信用風險監控 - 頁面元件
 */

import { useState, useEffect } from 'react';
import { useCreditMonitor } from '../hooks/useCreditMonitor';
import { CreditMonitorRecord, SignalLevel, SectorScore, SectorScores } from '../types/creditMonitor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, TrendingUp, TrendingDown, Activity, DollarSign, Cpu, Layers, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Layout } from '@/components/Layout';

// ============================================================================
// 燈號顏色配置
// ============================================================================

const SIGNAL_COLORS: Record<SignalLevel, string> = {
  '綠燈': '#437a22',
  '黃燈': '#d19900',
  '紅燈': '#a13544',
};

const SIGNAL_BG_COLORS: Record<SignalLevel, string> = {
  '綠燈': 'rgba(67, 122, 34, 0.15)',
  '黃燈': 'rgba(209, 153, 0, 0.15)',
  '紅燈': 'rgba(161, 53, 68, 0.15)',
};

// ============================================================================
// 板塊資訊
// ============================================================================

interface SectorInfo {
  key: keyof SectorScores;
  name: string;
  weight: number;
  icon: React.ReactNode;
  description: string;
}

const SECTOR_INFOS: SectorInfo[] = [
  {
    key: 'creditMarket',
    name: '信用市場',
    weight: 35,
    icon: <DollarSign className="h-5 w-5" />,
    description: '高收益債、投資級債、HYG、JNK、LQD、BKLN',
  },
  {
    key: 'liquidityStress',
    name: '流動性/壓力',
    weight: 25,
    icon: <Activity className="h-5 w-5" />,
    description: 'OFR FSI、VIX、美元指數',
  },
  {
    key: 'aiInfraCore',
    name: 'AI基建核心',
    weight: 20,
    icon: <Cpu className="h-5 w-5" />,
    description: 'CRWV、NBIS、ORCL、VRT、DLR、EQIX',
  },
  {
    key: 'chipSupplyChain',
    name: '上游供應鏈',
    weight: 10,
    icon: <Layers className="h-5 w-5" />,
    description: 'NVDA、AMD、AVGO、TSM',
  },
  {
    key: 'privateCreditFunding',
    name: '資金供給端',
    weight: 10,
    icon: <Wallet className="h-5 w-5" />,
    description: 'ARCC、BXSL、OBDC（私募信貸）',
  },
];

// ============================================================================
// 子元件：燈號顯示
// ============================================================================

function SignalIndicator({ signal, size = 'md' }: { signal: SignalLevel; size?: 'sm' | 'md' | 'lg' }) {
  const color = SIGNAL_COLORS[signal];
  const sizeClasses = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-6 h-6',
  };

  return (
    <div
      className={cn('rounded-full', sizeClasses[size])}
      style={{ backgroundColor: color }}
      title={signal}
    />
  );
}

// ============================================================================
// 子元件：板塊分數卡片
// ============================================================================

function SectorScoreCard({ sector, info }: { sector: SectorScore; info: SectorInfo }) {
  const color = SIGNAL_COLORS[sector.signal];

  return (
    <Card className="relative overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="text-muted-foreground">{info.icon}</div>
            <CardTitle className="text-sm font-medium">{info.name}</CardTitle>
          </div>
          <Badge variant="outline" className="text-xs">
            權重 {info.weight}%
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-end justify-between">
          <div>
            <div className="text-3xl font-bold" style={{ color }}>
              {sector.score}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {info.description}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SignalIndicator signal={sector.signal} size="md" />
            <span className="text-sm font-medium" style={{ color }}>
              {sector.signal}
            </span>
          </div>
        </div>
        {/* 簡易進度條 */}
        <div className="mt-3 h-1.5 w-full bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${sector.score}%`,
              backgroundColor: color,
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// 子元件：歷史資料表格
// ============================================================================

function DataTable({ data }: { data: CreditMonitorRecord[] }) {
  if (data.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        暂无资料
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium">日期</th>
            <th className="px-3 py-2 text-left font-medium">季度</th>
            <th className="px-3 py-2 text-center font-medium">信用市場</th>
            <th className="px-3 py-2 text-center font-medium">流動性/壓力</th>
            <th className="px-3 py-2 text-center font-medium">AI基建核心</th>
            <th className="px-3 py-2 text-center font-medium">上游供應鏈</th>
            <th className="px-3 py-2 text-center font-medium">資金供給端</th>
            <th className="px-3 py-2 text-center font-medium">加權總分</th>
            <th className="px-3 py-2 text-center font-medium">燈號</th>
          </tr>
        </thead>
        <tbody>
          {data.map((record, idx) => (
            <tr key={idx} className="border-t">
              <td className="px-3 py-2">{record.日期}</td>
              <td className="px-3 py-2">{record.季度}</td>
              <td className="px-3 py-2 text-center">
                <span style={{ color: SIGNAL_COLORS[record.sectorScores.creditMarket.signal] }}>
                  {record.sectorScores.creditMarket.score}
                </span>
              </td>
              <td className="px-3 py-2 text-center">
                <span style={{ color: SIGNAL_COLORS[record.sectorScores.liquidityStress.signal] }}>
                  {record.sectorScores.liquidityStress.score}
                </span>
              </td>
              <td className="px-3 py-2 text-center">
                <span style={{ color: SIGNAL_COLORS[record.sectorScores.aiInfraCore.signal] }}>
                  {record.sectorScores.aiInfraCore.score}
                </span>
              </td>
              <td className="px-3 py-2 text-center">
                <span style={{ color: SIGNAL_COLORS[record.sectorScores.chipSupplyChain.signal] }}>
                  {record.sectorScores.chipSupplyChain.score}
                </span>
              </td>
              <td className="px-3 py-2 text-center">
                <span style={{ color: SIGNAL_COLORS[record.sectorScores.privateCreditFunding.signal] }}>
                  {record.sectorScores.privateCreditFunding.score}
                </span>
              </td>
              <td className="px-3 py-2 text-center font-medium">
                {record.weightedTotal}
              </td>
              <td className="px-3 py-2 text-center">
                <div className="flex items-center justify-center gap-1.5">
                  <SignalIndicator signal={record.finalSignal} size="sm" />
                  <span style={{ color: SIGNAL_COLORS[record.finalSignal] }}>
                    {record.finalSignal}
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// 主頁面元件
// ============================================================================

export default function CreditMonitorPage() {
  const {
    filteredData,
    loading,
    error,
    quarters,
    activeQuarter,
    latest,
    lastUpdated,
    setActiveQuarter,
    refetch,
  } = useCreditMonitor();

  if (loading) {
    return (
      <Layout title="AI 基建信用風險監控" subtitle="系統性風險早期預警框架">
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
      <Layout title="AI 基建信用風險監控" subtitle="系統性風險早期預警框架">
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

  return (
    <Layout title="AI 基建信用風險監控" subtitle="系統性風險早期預警框架">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        {/* 頁面標題 */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">AI 基建系統性信用風險監控</h1>
            <p className="text-sm text-muted-foreground mt-1">
              模擬系統性風險早期預警框架（跨信用市場、流動性、產業鏈多板塊交叉驗證）
            </p>
          </div>
          {lastUpdated && (
            <div className="text-xs text-muted-foreground">
              最后更新：{new Date(lastUpdated).toLocaleString('zh-TW')}
            </div>
          )}
        </div>

        {/* 今日風險狀態 */}
        {latest && (
          <Card className="overflow-hidden">
            <div
              className="p-6"
              style={{ backgroundColor: SIGNAL_BG_COLORS[latest.finalSignal] }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-muted-foreground">今日風險狀態</div>
                  <div className="flex items-center gap-3 mt-2">
                    <SignalIndicator signal={latest.finalSignal} size="lg" />
                    <span
                      className="text-3xl font-bold"
                      style={{ color: SIGNAL_COLORS[latest.finalSignal] }}
                    >
                      {latest.finalSignal}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">加權總分</div>
                  <div
                    className="text-4xl font-bold"
                    style={{ color: SIGNAL_COLORS[latest.finalSignal] }}
                  >
                    {latest.weightedTotal}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    （滿分 100）
                  </div>
                </div>
              </div>

              {/* 觸發的規則 */}
              {latest.triggeredRules.length > 0 && (
                <div className="mt-4 pt-4 border-t border-border/30">
                  <div className="flex items-center gap-2 text-sm font-medium mb-2">
                    <AlertTriangle className="h-4 w-4" />
                    觸發的規則
                  </div>
                  <ul className="space-y-1">
                    {latest.triggeredRules.map((rule, idx) => (
                      <li key={idx} className="text-sm text-muted-foreground">
                        • {rule}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* 五個板塊分數卡片 */}
        {latest && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {SECTOR_INFOS.map((info) => (
              <SectorScoreCard
                key={info.key}
                sector={latest.sectorScores[info.key]}
                info={info}
              />
            ))}
          </div>
        )}

        {/* 季度切換 */}
        {quarters.length > 0 && (
          <Tabs
            value={activeQuarter}
            onValueChange={setActiveQuarter}
            className="w-full"
          >
            <TabsList className="mb-4">
              {quarters.map((quarter) => (
                <TabsTrigger key={quarter} value={quarter}>
                  {quarter}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        {/* 歷史資料表格 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">歷史資料</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable data={filteredData} />
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}