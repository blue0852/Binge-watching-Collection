// Express 服务器入口

import express from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { cacheRouter } from './routes/cache.js';
import { moviesRouter } from './routes/movies.js';
import { imagesRouter } from './routes/images.js';
import { streamRouter } from './routes/stream.js';
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

/**
 * 监听地址：默认只绑回环。
 * /api/stream、/api/img 是任意 URL 代理，不应暴露到局域网；确需局域网访问时显式设置 HOST=0.0.0.0。
 */
const LISTEN_HOST = process.env.HOST || '127.0.0.1';
/** 请求日志默认关闭：打包版 stdout 管道无人消费，大量日志会阻塞事件循环 */
const LOG_REQUESTS = process.env.LOG_REQUESTS === '1';

export function createApp() {
  const app = express();
  const frontendDist = getFrontendDistPath();

  if (LOG_REQUESTS) {
    app.use((req, _res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
      next();
    });
  }

  app.use(express.json({ limit: '64kb' }));

  app.use('/api/img', imagesRouter);
  app.use('/api/stream', streamRouter);
  app.use('/api/cache', cacheRouter);
  app.use('/api/movies', moviesRouter);
  app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

  // 文件名带 hash，可放心 immutable；index.html 仍走 1 小时
  app.use(
    '/assets',
    express.static(path.join(frontendDist, 'assets'), { immutable: true, maxAge: '1y' }),
  );
  app.use(express.static(frontendDist, { maxAge: '1h', index: false }));
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
    const server = app.listen({ port: listenPort, host: LISTEN_HOST }, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      const shownHost = LISTEN_HOST === '0.0.0.0' || LISTEN_HOST === '::' ? 'localhost' : LISTEN_HOST;
      console.log(`\n  🎬 Public Domain Cinema 已启动`);
      console.log(`  → http://${shownHost}:${actualPort}\n`);
      resolve({ server, port: actualPort });
    });
    server.on('error', reject);
  });
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

/** Electron 子进程 fork 后端时 import.meta 路径可能与 argv 不完全一致 */
const isDesktopBackend =
  process.env.ELECTRON_RUN_AS_NODE === '1' && Boolean(process.argv[1]?.includes('server'));

if (isDirectRun || isDesktopBackend) {
  startServer(resolvePort()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
