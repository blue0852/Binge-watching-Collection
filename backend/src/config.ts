// 加载项目根目录 config.json

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getConfigPath } from './paths.js';

export interface VodSiteConfig {
  api: string;
  name: string;
  detail?: string;
  /** 该站直连不通、只能走代理：请求时跳过直连，直接经代理（避免白等探测预算） */
  proxy_only?: boolean;
}

export interface AppConfig {
  cache_time: number;
  api_site: Record<string, VodSiteConfig>;
  /** 上游代理地址，如 http://127.0.0.1:7897 或 socks5://127.0.0.1:7890 */
  proxy?: string;
  /** always=全部走代理；fallback=直连失败才走代理（默认） */
  proxy_mode?: 'always' | 'fallback';
}

const DEFAULT_CACHE_TIME = 3600;

/** 代理地址校验：仅接受 http/https/socks5 协议 */
export function normalizeProxyUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:'].includes(url.protocol)) return undefined;
    if (!url.hostname) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

let cached: AppConfig | null = null;

/** 读取 config.json；解析失败时退回空配置并打印明确错误，避免首个请求直接 500 */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const configPath = getConfigPath();
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<AppConfig>;
    const apiSite =
      parsed?.api_site && typeof parsed.api_site === 'object' && !Array.isArray(parsed.api_site)
        ? parsed.api_site
        : {};
    const cacheTime = Number(parsed?.cache_time);
    const proxy = normalizeProxyUrl(parsed?.proxy);
    const proxyMode = parsed?.proxy_mode === 'always' ? 'always' : 'fallback';
    cached = {
      cache_time: Number.isFinite(cacheTime) && cacheTime > 0 ? cacheTime : DEFAULT_CACHE_TIME,
      api_site: apiSite,
      ...(proxy ? { proxy, proxy_mode: proxyMode } : {}),
    };
  } catch (e) {
    console.error(`[config] 无法读取 ${configPath}：${(e as Error).message}`);
    cached = { cache_time: DEFAULT_CACHE_TIME, api_site: {} };
  }
  return cached;
}

export function getVodSite(key: string): VodSiteConfig | undefined {
  return loadConfig().api_site[key];
}

export function listVodSources(): Array<{ key: string } & VodSiteConfig> {
  const { api_site } = loadConfig();
  return Object.entries(api_site).map(([key, site]) => ({ key, ...site }));
}

export function getCacheTtlMs(): number {
  return loadConfig().cache_time * 1000;
}

export function invalidateConfigCache(): void {
  cached = null;
}

function persistConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  // 先写临时文件再 rename，避免断电/被杀进程后留下半截 JSON
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, configPath);
  invalidateConfigCache();
}

const SITE_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_SITE_KEYS = new Set(['archive']);

function assertSiteKey(key: string): void {
  const trimmed = key.trim();
  if (!SITE_KEY_RE.test(trimmed)) {
    throw new Error('站点 key 仅允许字母、数字、下划线与连字符，长度 1–64');
  }
  if (RESERVED_SITE_KEYS.has(trimmed)) {
    throw new Error(`站点 key「${trimmed}」为系统保留`);
  }
}

function assertHttpUrl(raw: string, label: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} 必须是有效的 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} 须为 http 或 https 地址`);
  }
  return trimmed;
}

export function addVodSite(
  key: string,
  site: VodSiteConfig,
): Array<{ key: string } & VodSiteConfig> {
  assertSiteKey(key);
  const api = assertHttpUrl(site.api, 'api');
  const name = site.name.trim();
  if (!name) throw new Error('name 不能为空');
  const detail = site.detail?.trim();
  if (detail) assertHttpUrl(detail, 'detail');

  const config = loadConfig();
  const id = key.trim();
  if (config.api_site[id]) {
    throw new Error(`站点 key「${id}」已存在`);
  }

  config.api_site[id] = {
    api,
    name,
    ...(detail ? { detail } : {}),
    ...(site.proxy_only === true ? { proxy_only: true } : {}),
  };
  persistConfig(config);
  return listVodSources();
}

export function removeVodSite(key: string): Array<{ key: string } & VodSiteConfig> {
  const id = key.trim();
  if (!id) throw new Error('缺少站点 key');
  const config = loadConfig();
  if (!config.api_site[id]) {
    throw new Error(`站点 key「${id}」不存在`);
  }
  delete config.api_site[id];
  persistConfig(config);
  return listVodSources();
}

/** 读取当前代理设置 */
export function getProxySettings(): { proxy?: string; proxy_mode: 'always' | 'fallback' } {
  const config = loadConfig();
  return {
    ...(config.proxy ? { proxy: config.proxy } : {}),
    proxy_mode: config.proxy_mode === 'always' ? 'always' : 'fallback',
  };
}

/** 写入/清除代理设置；传 null 表示关闭代理 */
export function setProxySettings(input: {
  proxy?: string | null;
  mode?: 'always' | 'fallback';
}): { proxy?: string; proxy_mode: 'always' | 'fallback' } {
  const config = loadConfig();
  if (input.proxy === null || input.proxy === undefined || input.proxy === '') {
    delete config.proxy;
    delete config.proxy_mode;
    persistConfig(config);
    return getProxySettings();
  }
  const proxy = normalizeProxyUrl(input.proxy);
  if (!proxy) {
    throw new Error('代理地址无效，示例：http://127.0.0.1:7897 或 socks5://127.0.0.1:1080');
  }
  config.proxy = proxy;
  config.proxy_mode = input.mode === 'always' ? 'always' : 'fallback';
  persistConfig(config);
  return getProxySettings();
}
