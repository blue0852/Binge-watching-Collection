// 清空服务端 API 内存缓存

import { Router } from 'express';
import { invalidateConfigCache } from '../config.js';
import { apiCache } from '../services/memoryCache.js';
import { clearMediaCaches } from '../services/streamSegmentCache.js';

export const cacheRouter = Router();

/** POST /api/cache/refresh — 清空列表/分类/搜索等内存缓存 */
cacheRouter.post('/refresh', (_req, res) => {
  const cleared = apiCache.clear();
  const media = clearMediaCaches();
  invalidateConfigCache();
  res.json({ ok: true, cleared, media, time: Date.now() });
});
