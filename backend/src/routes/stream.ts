// 流媒体代理：绕过 CDN 防盗链 / CORS / 自签证书，并重写 m3u8 分片地址

import { Router } from 'express';
import { fetchUpstreamBuffer } from '../services/upstreamFetch.js';

export const streamRouter = Router();

function isAllowedUrl(raw: string): boolean {
  return raw.startsWith('http://') || raw.startsWith('https://');
}

function isM3u8Body(url: string, contentType: string, text: string): boolean {
  if (url.includes('.m3u8')) return true;
  if (/mpegurl|m3u8/i.test(contentType)) return true;
  return text.trimStart().startsWith('#EXTM3U');
}

function toProxyUrl(absUrl: string): string {
  return `/api/stream?url=${encodeURIComponent(absUrl)}`;
}

/** 将 m3u8 内相对/绝对分片 URL 改写为本地代理 */
function rewriteM3u8(text: string, baseUrl: string): string {
  const base = new URL(baseUrl);

  const abs = (raw: string) => new URL(raw, base).href;

  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_m, uri: string) => {
          try {
            return `URI="${toProxyUrl(abs(uri))}"`;
          } catch {
            return _m;
          }
        });
      }
      const trimmed = line.trim();
      if (!trimmed) return line;
      try {
        return toProxyUrl(abs(trimmed));
      } catch {
        return line;
      }
    })
    .join('\n');
}

/**
 * GET /api/stream?url=https://...
 * 代理 m3u8 / ts / mp4
 */
streamRouter.get('/', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!isAllowedUrl(raw)) {
    res.status(400).json({ error: '无效的流媒体 URL' });
    return;
  }

  try {
    const { buffer, contentType } = await fetchUpstreamBuffer(raw);
    const text = buffer.toString('utf8');

    if (isM3u8Body(raw, contentType, text)) {
      const rewritten = rewriteM3u8(text, raw);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(rewritten);
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (e) {
    res.status(502).json({ error: '流媒体代理失败', detail: (e as Error).message });
  }
});
