// Express 服务器入口

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moviesRouter } from './routes/movies.js';
import { imagesRouter } from './routes/images.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// 简单日志中间件
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// API 路由
app.use('/api/img', imagesRouter);
app.use('/api/movies', moviesRouter);

// 健康检查
app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

// 生产环境：托管前端构建产物
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
// SPA 回退：非 /api 路径都返回 index.html
app.get(/^\/(?!api).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`\n  🎬 Public Domain Cinema 后端已启动`);
  console.log(`  → API:    http://localhost:${PORT}/api`);
  console.log(`  → 前端:   http://localhost:${PORT} (生产模式)\n`);
});
