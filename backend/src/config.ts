// 加载项目根目录 config.json

import { readFileSync, writeFileSync } from 'node:fs';
import { getConfigPath } from './paths.js';

export interface VodSiteConfig {
  api: string;
  name: string;
  detail?: string;
}

export interface AppConfig {
  cache_time: number;
  api_site: Record<string, VodSiteConfig>;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const configPath = getConfigPath();
  cached = JSON.parse(readFileSync(configPath, 'utf-8')) as AppConfig;
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
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
