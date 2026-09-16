// 图片代理：绕过 CDN 防盗链

import { Router } from 'express';
import fetch from 'node-fetch';

export const imagesRouter = Router();

/**
 * GET /api/img?url=https://...
 * 代理外部封面图，避免浏览器 Referer 限制
 */
imagesRouter.get('/', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    res.status(400).json({ error: '无效的图片 URL' });
    return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  const tryUrls = [raw];
  if (raw.startsWith('https://')) {
    tryUrls.push(raw.replace(/^https:\/\//, 'http://'));
  }

  let lastError: Error | null = null;
  for (const target of tryUrls) {
    try {
      const origin = new URL(target).origin;
      const upstream = await fetch(target, {
        timeout: 10000,
        headers: { ...headers, Referer: `${origin}/` },
      } as never);

      if (!upstream.ok) {
        lastError = new Error(`图片获取失败: ${upstream.status}`);
        continue;
      }

      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
      return;
    } catch (e) {
      lastError = e as Error;
    }
  }

  res.status(502).json({ error: '图片代理失败', detail: lastError?.message });
});
