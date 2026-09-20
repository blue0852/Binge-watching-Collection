// 图片代理：绕过 CDN 防盗链 / WAF / 自签证书

import { Router } from 'express';
import { fetchUpstreamBuffer } from '../services/upstreamFetch.js';

export const imagesRouter = Router();

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
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    res.status(400).json({ error: '无效的图片 URL' });
    return;
  }

  const tryUrls = [raw];
  if (raw.startsWith('https://')) {
    tryUrls.push(raw.replace(/^https:\/\//, 'http://'));
  }

  let lastError: Error | null = null;
  for (const target of tryUrls) {
    try {
      const { buffer, contentType } = await fetchUpstreamBuffer(target);
      if (!isImageContent(contentType, buffer)) {
        lastError = new Error('上游返回非图片内容');
        continue;
      }
      res.setHeader('Content-Type', contentType.startsWith('image/') ? contentType : 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
      return;
    } catch (e) {
      lastError = e as Error;
    }
  }

  res.status(502).json({ error: '图片代理失败', detail: lastError?.message });
});
