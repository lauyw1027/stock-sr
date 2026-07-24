import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

// Use process.cwd() for Vercel - more reliable than __dirname in bundled code
function getDistPath() {
  // In production Vercel, process.cwd() is /var/task
  return path.resolve(process.cwd(), "dist/client");
}

export function serveStatic(app: Express) {
  // Vite builds to dist/client, not dist/public
  const distPath = getDistPath();
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
