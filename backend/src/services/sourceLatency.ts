/** 探测各资源站 API 连接延迟（毫秒），结果短 TTL 缓存并落盘复用 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import fetch from 'node-fetch';
import { getConfigPath } from '../paths.js';
import { getVodSite, listVodSources } from '../config.js';
import { agentFor } from './upstreamFetch.js';
import { timeoutSignal } from './http.js';

function discardBody(body: unknown): void {
  const stream = body as Readable | null;
  stream?.destroy();
}

const ARCHIVE_KEY = 'archive';
const ARCHIVE_PROBE_URL = 'https://archive.org/';
const PROBE_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 60_000;
const PROBE_CONCURRENCY = 16;
/** 落盘结果最多复用 30 分钟，避免启动即探测 50 个站 */
const PERSISTED_MAX_AGE_MS = 30 * 60 * 1000;
const LATENCY_CACHE_FILE = 'latency.json';

const PROBE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
};

export interface SourceLatencyResult {
  latencies: Record<string, number | null>;
  measuredAt: number;
}

let cached: SourceLatencyResult | null = null;
let inflight: Promise<SourceLatencyResult> | null = null;

function latencyCachePath(): string {
  return path.join(path.dirname(getConfigPath()), LATENCY_CACHE_FILE);
}

function readPersisted(): SourceLatencyResult | null {
  try {
    const data = JSON.parse(readFileSync(latencyCachePath(), 'utf-8')) as SourceLatencyResult;
    if (!data?.latencies || typeof data.measuredAt !== 'number') return null;
    if (Date.now() - data.measuredAt > PERSISTED_MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function persist(result: SourceLatencyResult): void {
  try {
    const target = latencyCachePath();
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(result), 'utf-8');
    renameSync(tmp, target);
  } catch {
    /* 只读目录（如 Program Files）下静默跳过 */
  }
}

function vodListProbeUrl(api: string): string {
  const sep = api.includes('?') ? '&' : '?';
  return `${api}${sep}ac=list&pg=1`;
}

function originFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '';
  }
}

async function probeUrl(url: string): Promise<number | null> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        ...PROBE_HEADERS,
        Referer: originFromUrl(url),
      },
      agent: agentFor(url),
      signal: timeoutSignal(PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      discardBody(res.body);
      return null;
    }
    discardBody(res.body);
    return ms;
  } catch {
    return null;
  }
}

async function probeVodKey(key: string): Promise<number | null> {
  const site = getVodSite(key);
  if (!site) return null;
  const urls = [vodListProbeUrl(site.api)];
  if (site.api.startsWith('http://')) {
    urls.push(vodListProbeUrl(site.api.replace(/^http:\/\//, 'https://')));
  }
  for (const url of urls) {
    const ms = await probeUrl(url);
    if (ms !== null) return ms;
  }
  return null;
}

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function measure(): Promise<SourceLatencyResult> {
  const startedAt = Date.now();
  const vodKeys = listVodSources().map((s) => s.key);
  const latencies: Record<string, number | null> = {};

  const [archiveMs, vodMs] = await Promise.all([
    probeUrl(ARCHIVE_PROBE_URL),
    runPool(vodKeys, PROBE_CONCURRENCY, async (key) => ({
      key,
      ms: await probeVodKey(key),
    })),
  ]);

  latencies[ARCHIVE_KEY] = archiveMs;
  for (const { key, ms } of vodMs) {
    latencies[key] = ms;
  }

  const result: SourceLatencyResult = { latencies, measuredAt: startedAt };
  cached = result;
  persist(result);
  return result;
}

export async function measureAllSourceLatencies(): Promise<SourceLatencyResult> {
  const now = Date.now();
  if (cached && now - cached.measuredAt < CACHE_TTL_MS) return cached;

  if (!cached) {
    const persisted = readPersisted();
    if (persisted) {
      cached = persisted;
      return persisted;
    }
  }

  // 多个组件同时请求时只探测一轮
  if (inflight) return inflight;
  inflight = measure().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function clearSourceLatencyCache(): void {
  cached = null;
}
