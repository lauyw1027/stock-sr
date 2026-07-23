/**
 * AI 基建系統性信用風險監控 - React Hook
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  CreditMonitorData,
  CreditMonitorRecord,
  CreditMonitorError,
  UseCreditMonitorResult,
} from '../types/creditMonitor';

const API_BASE = '/api/credit-monitor';

/**
 * Credit Monitor 資料 Hook
 * @param selectedQuarter - 可選的季度過濾參數
 */
export function useCreditMonitor(selectedQuarter?: string): UseCreditMonitorResult {
  const [data, setData] = useState<CreditMonitorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CreditMonitorError | null>(null);
  const [activeQuarter, setActiveQuarter] = useState<string>('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(API_BASE);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch data');
      }

      const result: CreditMonitorData = await response.json();
      setData(result);

      // 設定 activeQuarter
      if (selectedQuarter) {
        setActiveQuarter(selectedQuarter);
      } else if (result.latestQuarter) {
        setActiveQuarter(result.latestQuarter);
      }
    } catch (err) {
      setError({
        error: 'fetch_error',
        message: err instanceof Error ? err.message : 'Unknown error occurred',
      });
    } finally {
      setLoading(false);
    }
  }, [selectedQuarter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // 根據 activeQuarter 過濾資料
  const filteredData = useMemo(() => {
    if (!data?.data) return [];
    
    if (!activeQuarter) {
      return data.data;
    }
    
    return data.data.filter(record => record.季度 === activeQuarter);
  }, [data, activeQuarter]);

  // 取得最新一筆記錄
  const latest = useMemo(() => {
    if (!data?.data || data.data.length === 0) return null;
    return data.data[data.data.length - 1];
  }, [data]);

  // 取得所有可用季度
  const quarters = useMemo(() => {
    return data?.quarters ?? [];
  }, [data]);

  // 取得最後更新時間
  const lastUpdated = useMemo(() => {
    return data?.lastUpdated ?? null;
  }, [data]);

  // 切換季度
  const handleSetActiveQuarter = useCallback((quarter: string) => {
    setActiveQuarter(quarter);
  }, []);

  return {
    data,
    filteredData,
    loading,
    error,
    quarters,
    activeQuarter,
    latest,
    lastUpdated,
    setActiveQuarter: handleSetActiveQuarter,
    refetch: fetchData,
  };
}