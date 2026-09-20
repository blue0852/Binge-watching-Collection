// 上游 HTTP 请求：Node fetch + 自签证书容忍；Windows 下 WAF 拦截时回退系统 TLS

import { execFile } from 'node:child_process';
import https from 'node:https';
import { promisify } from 'node:util';
import fetch from 'node-fetch';

const execFileAsync = promisify(execFile);
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

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
  const t = text.trimStart().slice(0, 32).toLowerCase();
  return t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<');
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

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { maxBuffer: 20 * 1024 * 1024, timeout: 20000, encoding: 'utf8' },
  );
  return stdout;
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
  const isHttps = url.startsWith('https://');
  const res = await fetch(url, {
    headers,
    agent: isHttps ? insecureAgent : undefined,
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
    const isHttps = url.startsWith('https://');
    const res = await fetch(url, {
      headers,
      agent: isHttps ? insecureAgent : undefined,
      timeout: 15000,
    } as never);
    if (!res.ok) throw new Error(`上游请求失败: ${res.status}`);
    const text = await res.text();
    if (!looksLikeHtml(text)) return text;
    nodeError = new Error('上游返回 HTML 页面（可能被 WAF 拦截）');
  } catch (e) {
    nodeError = e as Error;
  }

  if (process.platform !== 'win32') {
    throw nodeError ?? new Error('上游请求失败');
  }

  try {
    const text = await winFetchText(url, headers);
    if (looksLikeHtml(text)) {
      throw new Error('上游返回 HTML 页面（可能被 WAF 拦截）');
    }
    return text;
  } catch (e) {
    const winMsg = (e as Error).message;
    if (nodeError) {
      throw new Error(`${nodeError.message}；Windows 回退失败: ${winMsg}`);
    }
    throw e;
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

  if (process.platform !== 'win32') {
    throw nodeError ?? new Error('上游请求失败');
  }

  try {
    const buffer = await winFetchBuffer(url, headers);
    return { buffer, contentType: guessContentType(url) };
  } catch (e) {
    const winMsg = (e as Error).message;
    if (nodeError) {
      throw new Error(`${nodeError.message}；Windows 回退失败: ${winMsg}`);
    }
    throw e;
  }
}

function guessContentType(url: string): string {
  if (url.includes('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (url.includes('.ts')) return 'video/mp2t';
  if (url.includes('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}
