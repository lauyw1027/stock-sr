import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import cron from "node-cron";
import { scanCreditSpreadOpportunities } from "./creditSpreadScanner";
import { getCachedData } from "./stocks";

const app = express();
const httpServer = createServer(app);

// ============================================================================
// Credit Spread Cron Job - 每30分鐘自動掃描
// ============================================================================
let isCreditSpreadJobRunning = false;

// 每30分鐘觸發一次，全天候排程；實際掃描與否由 scanCreditSpreadOpportunities 內部的
// isUSMarketHours() 判斷，非交易時段會自動跳過，不會浪費資源
cron.schedule("*/30 * * * *", async () => {
  if (isCreditSpreadJobRunning) {
    console.log("[NODE-CRON] Credit spread job already running, skipping this trigger");
    return;
  }

  isCreditSpreadJobRunning = true;
  const startTime = Date.now();

  try {
    console.log("[NODE-CRON] Triggering credit spread scan");

    const cached = getCachedData();
    if (!cached) {
      console.log("[NODE-CRON] No cache data available yet, skipping credit spread scan this cycle");
      return;
    }

    const { ath, atl } = cached;
    const combinedStocks = [...ath, ...atl];

    if (combinedStocks.length === 0) {
      console.log("[NODE-CRON] No ATH/ATL data available yet, skipping credit spread scan this cycle");
      return;
    }

    const result = await scanCreditSpreadOpportunities(combinedStocks, "balanced");

    console.log("[NODE-CRON] Credit spread scan finished", {
      marketStatus: result.marketStatus,
      bearCallCount: result.bearCallSpreads.length,
      bullPutCount: result.bullPutSpreads.length,
      durationMs: Date.now() - startTime,
    });
  } catch (e) {
    console.error("[NODE-CRON] Credit spread scan job failed:", e);
  } finally {
    isCreditSpreadJobRunning = false;
  }
});

console.log("[NODE-CRON] Credit spread scan job registered (every 30 minutes, market-hours-gated)");

// ============================================================================
// Express App Setup
// ============================================================================

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // Pre-warm stock list and ATH/ATL cache on server startup
  setTimeout(async () => {
    try {
      const { initializeStockList, scanAthAtl, scan52wAthAtl } = await import("./stocks");
      
      // First: Initialize stock list (must complete BEFORE scanning)
      console.log("[Startup] Initializing stock list...");
      await initializeStockList();
      
      // Second: Then scan ATH/ATL (now US_STOCKS is populated)
      console.log("[Startup] Pre-warming ATH/ATL cache...");
      await scanAthAtl(false);
      console.log("[Startup] Cache pre-warming complete");
    } catch (e) {
      console.error("[Startup] Initialization failed:", e);
    }
  }, 2000);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5001", 10);
  if (!process.env.VERCEL) {
    httpServer.listen(
      {
        port,
        host: "0.0.0.0",
      },
      () => {
        log(`serving on port ${port}`);
      },
    );
  }
})();
export default app;
