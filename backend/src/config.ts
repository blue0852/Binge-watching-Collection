// 加载项目根目录 config.json

import { readFileSync } from 'node:fs';
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
