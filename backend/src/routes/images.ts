// 图片代理：绕过 CDN 防盗链 / WAF / 自签证书

import { Router } from 'express';
import { fetchUpstreamBuffer } from '../services/upstreamFetch.js';
import { parseProxyUrl } from '../services/http.js';

export const imagesRouter = Router();

/** 单张封面上限，防止异常源把进程内存打满 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const MAX_CONCURRENCY = 6;

interface CachedImage {
  buffer: Buffer;
  contentType: string;
  expireAt: number;
}

const imageCache = new Map<string, CachedImage>();

let active = 0;
const waiters: Array<() => void> = [];

/** 简单信号量：限制并发回源数，避免 20 张封面同时失败重试 */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

function readCache(key: string): CachedImage | null {
  const hit = imageCache.get(key);
  if (!hit) return null;
  if (hit.expireAt <= Date.now()) {
    imageCache.delete(key);
    return null;
  }
  return hit;
}

function writeCache(key: string, entry: Omit<CachedImage, 'expireAt'>): void {
  if (imageCache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of imageCache) {
      if (v.expireAt <= now) imageCache.delete(k);
    }
    if (imageCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = imageCache.keys().next().value;
      if (oldest) imageCache.delete(oldest);
    }
  }
  imageCache.set(key, { ...entry, expireAt: Date.now() + CACHE_TTL_MS });
}

function isImageContent(contentType: string, buffer: Buffer): boolean {
  if (contentType.startsWith('image/')) return true;
  const sig = buffer.subarray(0, 12);
  if (sig[0] === 0xff && sig[1] === 0xd8) return true;
  if (sig[0] === 0x89 && sig[1] === 0x50) return true;
  if (sig[0] === 0x47 && sig[1] === 0x49) return true;
  if (sig[0] === 0x52 && sig[1] === 0x49) return true;
  return false;
}

/**
 * GET /api/img?url=https://...
 * 代理外部封面图，避免浏览器 Referer 限制
 */
imagesRouter.get('/', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  const parsed = parseProxyUrl(raw);
  if (!parsed) {
    res.status(400).json({ error: '无效的图片 URL' });
    return;
  }

  const key = parsed.href;
  const hit = readCache(key);
  if (hit) {
    res.setHeader('Content-Type', hit.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Image-Cache', 'HIT');
    res.send(hit.buffer);
    return;
  }

  const tryUrls = [key];
  if (key.startsWith('https://')) {
    tryUrls.push(key.replace(/^https:\/\//, 'http://'));
  }

  let lastError: Error | null = null;
  for (const target of tryUrls) {
    try {
      const { buffer, contentType } = await withSlot(() =>
        fetchUpstreamBuffer(target, undefined, 15_000, MAX_IMAGE_BYTES),
      );
      if (!isImageContent(contentType, buffer)) {
        lastError = new Error('上游返回非图片内容');
        continue;
      }
      const finalType = contentType.startsWith('image/') ? contentType : 'image/jpeg';
      writeCache(key, { buffer, contentType: finalType });
      res.setHeader('Content-Type', finalType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
      return;
    } catch (e) {
      lastError = e as Error;
    }
  }

  res.status(502).json({ error: '图片代理失败', detail: lastError?.message });
});
