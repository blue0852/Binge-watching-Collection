// 上游 HTTP 请求：Node fetch + 自签证书容忍；Windows 下 WAF 拦截时回退系统 TLS

import { execFile } from 'node:child_process';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import fetch from 'node-fetch';
import { loadConfig } from '../config.js';
import { createProxyAgent, mergeSignals, timeoutSignal } from './http.js';
import { isCacheableSegmentUrl, putCachedSegment } from './streamSegmentCache.js';
import { formatUpstreamErrorMessage, shouldSkipWindowsFallback } from './upstreamError.js';

const execFileAsync = promisify(execFile);
const AGENT_OPTS = { keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 };
/** 单个上游响应体上限，避免异常源把进程内存打满 */
const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;
/** 等待上游响应头的上限（只约束首字节，不打断已开始的播放） */
const UPSTREAM_HEADER_TIMEOUT_MS = 20_000;
/**
 * fallback 模式下直连的探测预算。
 * 被阻断的域名通常在 TLS 阶段秒级 RST，6s 足够；真正慢的站点交给代理。
 */
const DIRECT_PROBE_MS = 6_000;
const httpAgent = new http.Agent(AGENT_OPTS);
const httpsAgent = new https.Agent({ ...AGENT_OPTS, rejectUnauthorized: false });

function agentFor(url: string): http.Agent | https.Agent {
  return url.startsWith('https://') ? httpsAgent : httpAgent;
}

export { agentFor };

interface ProxySetting {
  url: string;
  mode: 'always' | 'fallback';
}

/** 读取 config.json 的 proxy；未配置则返回 null（保持原有直连行为） */
function proxySetting(): ProxySetting | null {
  try {
    const cfg = loadConfig();
    const url = typeof cfg.proxy === 'string' ? cfg.proxy.trim() : '';
    if (!url) return null;
    return { url, mode: cfg.proxy_mode === 'always' ? 'always' : 'fallback' };
  } catch {
    return null;
  }
}

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

/** node-fetch 的超时/取消统一转成可读错误，便于写入失败缓存 */
function normalizeFetchError(e: unknown): Error {
  const err = e as Error & { type?: string };
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new Error('上游请求超时');
  }
  return err instanceof Error ? err : new Error(String(e));
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
    { maxBuffer: MAX_UPSTREAM_BYTES, timeout: 30000, encoding: 'buffer' },
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
  maxBytes = MAX_UPSTREAM_BYTES,
  agent: http.Agent = agentFor(url),
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, {
    headers,
    agent,
    signal: timeoutSignal(timeoutMs),
  });
  if (!res.ok) throw new Error(`上游请求失败: ${res.status}`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    (res.body as unknown as Readable | null)?.destroy();
    throw new Error(`上游响应过大：${declared} 字节`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`上游响应过大：${buffer.length} 字节`);
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

/** 单次文本请求（不含回退逻辑） */
async function fetchTextAttempt(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  agent: http.Agent,
): Promise<string> {
  const res = await fetch(url, {
    headers,
    agent,
    signal: mergeSignals(timeoutSignal(timeoutMs), signal),
  });
  if (!res.ok) throw new Error(`上游请求失败: ${res.status}`);
  const text = await res.text();
  if (looksLikeHtml(text)) {
    throw new Error('上游返回 HTML 页面（可能被 WAF 拦截）');
  }
  return text;
}

/**
 * 请求上游并返回响应正文。
 * 顺序：代理(always) → 直连 → 代理(fallback) → Windows 系统 HTTP 回退。
 * 配置了 proxy 后，被 TLS 阻断的域名会由代理兜底，不影响可直连站点的速度。
 */
export async function fetchUpstreamText(
  url: string,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<string> {
  const headers = buildHeaders(url, extraHeaders);
  const proxy = proxySetting();

  if (proxy && proxy.mode === 'always') {
    try {
      return await fetchTextAttempt(
        url,
        headers,
        signal,
        timeoutMs,
        createProxyAgent(url, proxy.url),
      );
    } catch (e) {
      throw wrapUpstreamError(normalizeFetchError(e));
    }
  }

  let nodeError: Error | null = null;
  const directBudget = proxy ? Math.min(timeoutMs, DIRECT_PROBE_MS) : timeoutMs;

  try {
    return await fetchTextAttempt(url, headers, signal, directBudget, agentFor(url));
  } catch (e) {
    nodeError = normalizeFetchError(e);
  }

  // 外部预算耗尽（如全站搜索 7s 截止）时不再重试
  if (signal?.aborted) throw wrapUpstreamError(nodeError ?? new Error('上游请求超时'));

  if (proxy) {
    try {
      return await fetchTextAttempt(
        url,
        headers,
        signal,
        timeoutMs,
        createProxyAgent(url, proxy.url),
      );
    } catch (e) {
      const proxyError = normalizeFetchError(e);
      throw wrapUpstreamError(
        new Error(`直连失败：${nodeError.message}；代理重试失败：${proxyError.message}`),
      );
    }
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

/** 请求上游二进制（m3u8 分片、mp4 等）；配置代理时直连失败会自动经代理重试 */
export async function fetchUpstreamBuffer(
  url: string,
  extraHeaders?: Record<string, string>,
  timeoutMs = 30000,
  maxBytes = MAX_UPSTREAM_BYTES,
): Promise<{ buffer: Buffer; contentType: string }> {
  const headers = {
    ...buildHeaders(url, extraHeaders),
    Accept: '*/*',
  };
  const proxy = proxySetting();

  if (proxy && proxy.mode === 'always') {
    try {
      return await nodeFetchBuffer(
        url,
        headers,
        timeoutMs,
        maxBytes,
        createProxyAgent(url, proxy.url),
      );
    } catch (e) {
      throw wrapUpstreamError(normalizeFetchError(e));
    }
  }

  let nodeError: Error | null = null;
  const directBudget = proxy ? Math.min(timeoutMs, DIRECT_PROBE_MS) : timeoutMs;

  try {
    return await nodeFetchBuffer(url, headers, directBudget, maxBytes);
  } catch (e) {
    nodeError = normalizeFetchError(e);
  }

  if (proxy) {
    try {
      return await nodeFetchBuffer(
        url,
        headers,
        timeoutMs,
        maxBytes,
        createProxyAgent(url, proxy.url),
      );
    } catch (e) {
      const proxyError = normalizeFetchError(e);
      throw wrapUpstreamError(
        new Error(`直连失败：${nodeError.message}；代理重试失败：${proxyError.message}`),
      );
    }
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
  const proxy = proxySetting();

  // 只约束「等响应头」阶段：拿到响应头后立即清除定时器，避免打断正在播放的分片
  const headerFetch = async (agent: http.Agent): Promise<Awaited<ReturnType<typeof fetch>>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_HEADER_TIMEOUT_MS);
    try {
      return await fetch(url, { headers, agent, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const proxyFirst = proxy?.mode === 'always' && proxy.url;
  try {
    upstream = await headerFetch(
      proxyFirst ? createProxyAgent(url, proxyFirst) : agentFor(url),
    );
  } catch (raw) {
    if (proxy) {
      // 另一条路径重试：always 模式改为直连，fallback 模式改为走代理
      try {
        upstream = await headerFetch(
          proxyFirst ? agentFor(url) : createProxyAgent(url, proxy.url),
        );
      } catch (raw2) {
        throw normalizeFetchError(raw2);
      }
    } else if (process.platform === 'win32') {
      const e = normalizeFetchError(raw);
      if (e.message === '上游请求超时') throw e;
      const { buffer, contentType } = await fetchUpstreamBuffer(url);
      if (clientRes.headersSent) return;
      clientRes.setHeader('Content-Type', contentType);
      clientRes.setHeader('Cache-Control', 'public, max-age=3600');
      clientRes.setHeader('Accept-Ranges', 'bytes');
      clientRes.statusCode = 200;
      clientRes.end(buffer);
      return;
    } else {
      throw normalizeFetchError(raw);
    }
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
