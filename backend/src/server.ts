// Express 服务器入口

import express from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { moviesRouter } from './routes/movies.js';
import { imagesRouter } from './routes/images.js';
import { getFrontendDistPath } from './paths.js';

/** 解析端口；PORT=0 表示由系统分配空闲端口（桌面 exe 使用） */
function resolvePort(explicit?: number): number {
  if (explicit !== undefined && !Number.isNaN(explicit)) return explicit;
  const raw = process.env.PORT;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  return 3002;
}

const DEFAULT_PORT = resolvePort();

export function createApp() {
  const app = express();
  const frontendDist = getFrontendDistPath();

  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  app.use('/api/img', imagesRouter);
  app.use('/api/movies', moviesRouter);
  app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

  app.use(express.static(frontendDist));
  app.get(/^\/(?!api).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
      if (err) next();
    });
  });

  return app;
}

/** 启动 HTTP 服务，port=0 时自动分配空闲端口 */
export function startServer(port?: number): Promise<{ server: Server; port: number }> {
  const listenPort = resolvePort(port);
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      console.log(`\n  🎬 Public Domain Cinema 已启动`);
      console.log(`  → http://localhost:${actualPort}\n`);
      resolve({ server, port: actualPort });
    });
    server.on('error', reject);
  });
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  startServer(DEFAULT_PORT).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
