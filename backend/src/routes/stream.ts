// 流媒体代理：绕过 CDN 防盗链 / CORS / 自签证书，并重写 m3u8 分片地址

import { Router } from 'express';
import {
  fetchUpstreamBuffer,
  pipeUpstreamToResponse,
} from '../services/upstreamFetch.js';
import {
  getCachedPlaylist,
  getCachedSegment,
  isCacheableSegmentUrl,
  putCachedPlaylist,
} from '../services/streamSegmentCache.js';

export const streamRouter = Router();

function isAllowedUrl(raw: string): boolean {
  return raw.startsWith('http://') || raw.startsWith('https://');
}

function isM3u8Body(url: string, contentType: string, text: string): boolean {
  if (url.includes('.m3u8')) return true;
  if (/mpegurl|m3u8/i.test(contentType)) return true;
  return text.trimStart().startsWith('#EXTM3U');
}

function urlLooksLikeM3u8(url: string): boolean {
  return url.includes('.m3u8') || /[?&]m3u8/i.test(url);
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

function sendCachedSegment(
  res: import('express').Response,
  entry: { body: Buffer; contentType: string },
): void {
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Stream-Cache', 'HIT');
  res.status(200).end(entry.body);
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
    if (!urlLooksLikeM3u8(raw)) {
      if (isCacheableSegmentUrl(raw) && !req.headers.range) {
        const hit = getCachedSegment(raw);
        if (hit) {
          sendCachedSegment(res, hit);
          return;
        }
      }
      await pipeUpstreamToResponse(raw, req, res, {
        cacheSegment: isCacheableSegmentUrl(raw),
      });
      return;
    }

    const cachedPlaylist = getCachedPlaylist(raw);
    if (cachedPlaylist) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=45');
      res.setHeader('X-Stream-Cache', 'HIT');
      res.send(cachedPlaylist);
      return;
    }

    const { buffer, contentType } = await fetchUpstreamBuffer(raw);
    const text = buffer.toString('utf8');

    if (isM3u8Body(raw, contentType, text)) {
      const rewritten = rewriteM3u8(text, raw);
      putCachedPlaylist(raw, rewritten);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=45');
      res.send(rewritten);
      return;
    }

    if (!res.headersSent) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    }
  } catch (e) {
    if (!res.headersSent) {
      res.status(502).json({ error: '流媒体代理失败', detail: (e as Error).message });
    }
  }
});
