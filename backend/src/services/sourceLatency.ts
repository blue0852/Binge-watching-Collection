/** 探测各资源站 API 连接延迟（毫秒），结果短 TTL 缓存 */

import fetch from 'node-fetch';
import type { Readable } from 'node:stream';
import { getVodSite, listVodSources } from '../config.js';
import { agentFor } from './upstreamFetch.js';

function discardBody(body: unknown): void {
  const stream = body as Readable | null;
  stream?.destroy();
}

const ARCHIVE_KEY = 'archive';
const ARCHIVE_PROBE_URL = 'https://archive.org/';
const PROBE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;
const PROBE_CONCURRENCY = 10;

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
      timeout: PROBE_TIMEOUT_MS,
    } as never);
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

export async function measureAllSourceLatencies(): Promise<SourceLatencyResult> {
  const now = Date.now();
  if (cached && now - cached.measuredAt < CACHE_TTL_MS) {
    return cached;
  }

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

  cached = { latencies, measuredAt: now };
  return cached;
}

export function clearSourceLatencyCache(): void {
  cached = null;
}
