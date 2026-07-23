/**
 * AI 基建系統性信用風險監控 - Express API 路由
 */

import type { Server } from 'http';
import type { Express, Request, Response, NextFunction } from 'express';
import {
  getCreditMonitorData,
  getCreditMonitorDataByQuarter,
  triggerManualUpdate,
  backfillHistory,
  startCronJob,
} from '../jobs/creditMonitorNative.js';
import type { CreditMonitorData } from '../utils/creditMonitorTypes.js';

export function registerCreditMonitorRoutes(
  _httpServer: Server,
  app: Express
): void {
  // CORS 網域從環境變數讀取，預設為 Vercel 生產網域
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://stocksr.online';
  
  // Middleware 處理 CORS
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin as string | undefined;
    
    // 允許精確匹配或 null（直接存取）
    if (origin === allowedOrigin || !origin) {
      res.setHeader('Access-Control-Allow-Origin', origin || allowedOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    
    // 處理預檢請求
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    
    next();
  });
  
  // POST /api/credit-monitor/trigger - 手動觸發更新（用於測試或管理）
  // 必須放在 /credit-monitor 之前，避免被錯誤匹配
  app.post('/api/credit-monitor/trigger', async (req: Request, res: Response) => {
    try {
      // 可以加入簡單的認證（例如檢查 secret 參數）
      const secret = req.headers.authorization?.replace('Bearer ', '');
      const expectedSecret = process.env.CREDIT_MONITOR_SECRET;
      
      if (expectedSecret && secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      console.log('[CreditMonitor] Manual trigger received');
      const record = await triggerManualUpdate();
      
      if (record) {
        res.json({
          success: true,
          record,
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to update data',
        });
      }
    } catch (error) {
      console.error('[CreditMonitor API] Error triggering update:', error);
      res.status(500).json({
        error: 'Failed to trigger update',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
  
  // GET /api/credit-monitor - 回傳完整 JSON
  app.get('/api/credit-monitor', (_req: Request, res: Response) => {
    try {
      const data = getCreditMonitorData();
      res.json(data);
    } catch (error) {
      console.error('[CreditMonitor API] Error fetching data:', error);
      res.status(500).json({
        error: 'Failed to fetch credit monitor data',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
  
  // GET /api/credit-monitor/quarter/:quarter - 回傳指定季度過濾後資料
  app.get('/api/credit-monitor/quarter/:quarter', (req: Request, res: Response) => {
    try {
      const { quarter } = req.params;
      
      // 驗證季度格式
      if (!/^\d{4}Q[1-4]$/.test(quarter)) {
        return res.status(400).json({
          error: 'Invalid quarter format',
          message: 'Expected format: YYYYQ1, YYYYQ2, YYYYQ3, or YYYYQ4',
        });
      }
      
      const data = getCreditMonitorDataByQuarter(quarter);
      res.json(data);
    } catch (error) {
      console.error('[CreditMonitor API] Error fetching quarter data:', error);
      res.status(500).json({
        error: 'Failed to fetch quarter data',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
  
  // POST /api/credit-monitor/backfill - 回填歷史資料
  app.post('/api/credit-monitor/backfill', async (req: Request, res: Response) => {
    try {
      const secret = req.headers.authorization?.replace('Bearer ', '');
      const expectedSecret = process.env.CREDIT_MONITOR_SECRET;
      
      if (expectedSecret && secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const { startDate, endDate } = req.body;
      
      if (!startDate || !endDate) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'startDate and endDate are required (format: YYYY-MM-DD)',
        });
      }
      
      console.log(`[CreditMonitor API] Backfill request: ${startDate} to ${endDate}`);
      const filled = await backfillHistory(startDate, endDate);
      
      res.json({
        success: true,
        filled,
        startDate,
        endDate,
      });
    } catch (error) {
      console.error('[CreditMonitor API] Error during backfill:', error);
      res.status(500).json({
        error: 'Failed to backfill data',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
  
  // 初始化排程任務
  const cronEnabled = process.env.CREDIT_MONITOR_CRON_ENABLED !== 'false';
  if (cronEnabled) {
    // 預設每天 UTC 06:00 執行
    const cronExpression = process.env.CREDIT_MONITOR_CRON || '0 6 * * *';
    startCronJob(cronExpression);
  }
  
  console.log('[CreditMonitor] Routes registered');
}