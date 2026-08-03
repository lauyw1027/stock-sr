/**
 * 日元 Carry Trade 平倉風險監控 - React Hook
 */

import { useState, useEffect, useCallback } from 'react';
import {
  CarryTradeRiskData,
} from '../types/carryTradeRisk';

const API_BASE = '/api/carry-risk';

/**
 * Carry Trade 風險監控資料 Hook
 */
export function useCarryTradeRisk() {
  const [data, setData] = useState<CarryTradeRiskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ error: string; message: string } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(API_BASE);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch data');
      }

      const result: CarryTradeRiskData = await response.json();
      setData(result);
    } catch (err) {
      setError({
        error: 'fetch_error',
        message: err instanceof Error ? err.message : 'Unknown error occurred',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}