// 上游 HTTP 请求：Node fetch + 自签证书容忍；Windows 下 WAF 拦截时回退系统 TLS

import { execFile } from 'node:child_process';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import fetch from 'node-fetch';
import { isCacheableSegmentUrl, putCachedSegment } from './streamSegmentCache.js';
import { formatUpstreamErrorMessage, shouldSkipWindowsFallback } from './upstreamError.js';

const execFileAsync = promisify(execFile);
const AGENT_OPTS = { keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 };
const httpAgent = new http.Agent(AGENT_OPTS);
const httpsAgent = new https.Agent({ ...AGENT_OPTS, rejectUnauthorized: false });

function agentFor(url: string): http.Agent | https.Agent {
  return url.startsWith('https://') ? httpsAgent : httpAgent;
}

export { agentFor };

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

function originFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '';
  }
}

function looksLikeHtml(text: string): boolean {
  const t = text.trimStart().slice(0, 64).toLowerCase();
  if (t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<')) return true;
  return text.includes('Just a moment') || text.includes('cf-chl');
}

function wrapUpstreamError(err: Error): Error {
  return new Error(formatUpstreamErrorMessage(err));
}

function psQuote(raw: string): string {
  return raw.replace(/'/g, "''");
}

async function winFetchText(url: string, headers: Record<string, string>): Promise<string> {
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `$h['${psQuote(k)}']='${psQuote(v)}'`)
    .join('\n');
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$h=@{}',
    headerLines,
    `$r=Invoke-WebRequest -Uri '${psQuote(url)}' -Headers $h -UseBasicParsing`,
    '$r.Content',
  ].join('\n');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 20 * 1024 * 1024, timeout: 20000, encoding: 'utf8' },
    );
    return stdout;
  } catch {
    throw new Error('Windows 回退请求失败');
  }
}

async function winFetchBuffer(url: string, headers: Record<string, string>): Promise<Buffer> {
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `$h['${psQuote(k)}']='${psQuote(v)}'`)
    .join('\n');
  const script = [
    "$ErrorActionPreference='Stop'",
    '$h=@{}',
    headerLines,
    `$r=Invoke-WebRequest -Uri '${psQuote(url)}' -Headers $h -UseBasicParsing`,
    '$out=[Console]::OpenStandardOutput()',
    '$out.Write($r.Content,0,$r.Content.Length)',
  ].join('\n');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { maxBuffer: 50 * 1024 * 1024, timeout: 30000, encoding: 'buffer' },
  );
  return stdout;
}

function buildHeaders(url: string, extraHeaders?: Record<string, string>): Record<string, string> {
  return {
    ...DEFAULT_HEADERS,
    Referer: originFromUrl(url),
    ...extraHeaders,
  };
}

async function nodeFetchBuffer(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, {
    headers,
    agent: agentFor(url),
    timeout: timeoutMs,
  } as never);
  if (!res.ok) throw new Error(`上游请求失败: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

/** 请求上游并返回响应正文（优先 Node；Windows 遇 WAF/证书问题时回退系统 HTTP） */
export async function fetchUpstreamText(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const headers = buildHeaders(url, extraHeaders);

  let nodeError: Error | null = null;

  try {
    const res = await fetch(url, {
      headers,
      agent: agentFor(url),
      timeout: 15000,
    } as never);
    if (!res.ok) throw new Error(`上游请求失败: ${res.status}`);
    const text = await res.text();
    if (!looksLikeHtml(text)) return text;
    nodeError = new Error('上游返回 HTML 页面（可能被 WAF 拦截）');
  } catch (e) {
    nodeError = e as Error;
  }

  if (process.platform !== 'win32' || (nodeError && shouldSkipWindowsFallback(nodeError))) {
    throw wrapUpstreamError(nodeError ?? new Error('上游请求失败'));
  }

  try {
    const text = await winFetchText(url, headers);
    if (looksLikeHtml(text)) {
      throw new Error('上游返回 HTML 页面（可能被 WAF 拦截）');
    }
    return text;
  } catch (e) {
    const combined = new Error(
      nodeError ? `${nodeError.message}；${(e as Error).message}` : (e as Error).message,
    );
    throw wrapUpstreamError(combined);
  }
}

/** 请求上游二进制（m3u8 分片、mp4 等） */
export async function fetchUpstreamBuffer(
  url: string,
  extraHeaders?: Record<string, string>,
  timeoutMs = 30000,
): Promise<{ buffer: Buffer; contentType: string }> {
  const headers = {
    ...buildHeaders(url, extraHeaders),
    Accept: '*/*',
  };

  let nodeError: Error | null = null;

  try {
    return await nodeFetchBuffer(url, headers, timeoutMs);
  } catch (e) {
    nodeError = e as Error;
  }

  if (process.platform !== 'win32' || (nodeError && shouldSkipWindowsFallback(nodeError))) {
    throw wrapUpstreamError(nodeError ?? new Error('上游请求失败'));
  }

  try {
    const buffer = await winFetchBuffer(url, headers);
    return { buffer, contentType: guessContentType(url) };
  } catch (e) {
    const combined = new Error(
      nodeError ? `${nodeError.message}；${(e as Error).message}` : (e as Error).message,
    );
    throw wrapUpstreamError(combined);
  }
}

export function guessContentType(url: string): string {
  if (url.includes('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (url.includes('.ts')) return 'video/mp2t';
  if (url.includes('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

const STREAM_FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
] as const;

export interface PipeUpstreamOptions {
  /** 完整分片响应写入内存缓存（HLS ts/m4s） */
  cacheSegment?: boolean;
}

/** 流式转发上游媒体（支持 Range），避免整段缓冲后再下发 */
export async function pipeUpstreamToResponse(
  url: string,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  options?: PipeUpstreamOptions,
): Promise<void> {
  const headers: Record<string, string> = {
    ...buildHeaders(url),
    Accept: '*/*',
  };
  const range = clientReq.headers.range;
  const hasRange = typeof range === 'string';
  if (hasRange) headers.Range = range;
  const shouldCacheSegment =
    Boolean(options?.cacheSegment) && !hasRange && isCacheableSegmentUrl(url);

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(url, {
      headers,
      agent: agentFor(url),
    } as never);
  } catch (e) {
    if (process.platform !== 'win32') throw e;
    const { buffer, contentType } = await fetchUpstreamBuffer(url);
    if (clientRes.headersSent) return;
    clientRes.setHeader('Content-Type', contentType);
    clientRes.setHeader('Cache-Control', 'public, max-age=3600');
    clientRes.setHeader('Accept-Ranges', 'bytes');
    clientRes.statusCode = 200;
    clientRes.end(buffer);
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    throw new Error(`上游请求失败: ${upstream.status}`);
  }

  for (const name of STREAM_FORWARD_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) clientRes.setHeader(name, value);
  }
  if (!upstream.headers.get('accept-ranges')) {
    clientRes.setHeader('Accept-Ranges', 'bytes');
  }
  clientRes.setHeader(
    'Cache-Control',
    shouldCacheSegment ? 'public, max-age=86400, immutable' : 'public, max-age=3600',
  );
  clientRes.statusCode = upstream.status;

  const body = upstream.body as unknown as Readable | null;
  if (!body) {
    clientRes.end();
    return;
  }

  const contentType =
    upstream.headers.get('content-type') || guessContentType(url);
  const chunks: Buffer[] = [];
  let collected = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const onClientClose = () => {
      body.destroy();
    };
    clientReq.once('close', onClientClose);

    if (shouldCacheSegment) {
      body.on('data', (chunk: Buffer) => {
        collected += chunk.length;
        if (collected <= 12 * 1024 * 1024) chunks.push(chunk);
      });
      body.on('end', () => {
        if (collected > 0 && collected <= 12 * 1024 * 1024) {
          putCachedSegment(url, Buffer.concat(chunks), contentType);
        }
      });
    }

    body.on('error', (err: Error) => done(err));
    clientRes.on('error', (err) => done(err));
    clientRes.on('finish', () => done());

    body.pipe(clientRes);
  });
}
