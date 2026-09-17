// MacCMS 风格 VOD 采集 API 客户端

import fetch from 'node-fetch';
import { getCacheTtlMs, getVodSite, listVodSources, type VodSiteConfig } from '../config.js';
import type {
  GlobalSearchResult,
  MovieDetail,
  MovieListItem,
  PaginatedResult,
  PlayableFile,
  VodCategory,
} from '../types.js';

const GLOBAL_SEARCH_BATCH = 12;
const GLOBAL_SEARCH_ROWS_PER_SITE = 6;

/** 简单内存缓存 */
interface CacheEntry<T> {
  value: T;
  expireAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expireAt > Date.now()) {
    return hit.value as T;
  }
  const value = await factory();
  cache.set(key, { value, expireAt: Date.now() + getCacheTtlMs() });
  return value;
}

/** MacCMS API 返回的列表项 */
interface VodListItem {
  vod_id: number | string;
  vod_name?: string;
  vod_pic?: string;
  vod_year?: string;
  vod_remarks?: string;
  vod_blurb?: string;
  vod_content?: string;
  type_name?: string;
  vod_actor?: string;
  vod_director?: string;
  vod_area?: string;
  vod_lang?: string;
  vod_score?: string | number;
  vod_play_from?: string;
  vod_play_url?: string;
}

interface VodClassItem {
  type_id: number;
  type_pid: number;
  type_name: string;
}

interface VodApiResponse {
  code?: number;
  msg?: string;
  page?: number;
  pagecount?: number;
  limit?: string | number;
  total?: number;
  list?: VodListItem[];
  class?: VodClassItem[];
}

function buildUrl(api: string, params: Record<string, string | number>): string {
  const sep = api.includes('?') ? '&' : '?';
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${api}${sep}${qs}`;
}

function candidateFetchUrls(url: string): string[] {
  const urls = [url];
  if (url.startsWith('http://')) {
    urls.push(url.replace(/^http:\/\//, 'https://'));
  }
  return [...new Set(urls)];
}

async function fetchVodApi(url: string): Promise<VodApiResponse> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  let lastError: Error | null = null;

  for (const tryUrl of candidateFetchUrls(url)) {
    try {
      const res = await fetch(tryUrl, { timeout: 15000, headers } as never);
      if (!res.ok) {
        lastError = new Error(`VOD API 请求失败: ${res.status}`);
        continue;
      }
      const data = (await res.json()) as VodApiResponse;
      if (data.code !== undefined && data.code !== 1) {
        throw new Error(data.msg || 'VOD API 返回错误');
      }
      return data;
    } catch (e) {
      lastError = e as Error;
    }
  }

  throw lastError ?? new Error('VOD API 请求失败');
}

function truncate(s: string, max = 300): string {
  if (!s) return '';
  const plain = s.replace(/<[^>]+>/g, '').trim();
  return plain.length > max ? plain.slice(0, max).trimEnd() + '…' : plain;
}

/** 补全相对路径封面 URL */
function normalizePicUrl(pic: string | undefined, site: VodSiteConfig): string {
  if (!pic) return '';
  const trimmed = pic.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  const base = (site.detail || site.api.replace(/\/api\.php.*$/i, '')).replace(/\/$/, '');
  return `${base}/${trimmed.replace(/^\//, '')}`;
}

/** 列表接口通常不含封面，批量请求 detail 补全 */
async function enrichWithThumbnails(
  source: string,
  site: VodSiteConfig,
  items: MovieListItem[],
): Promise<MovieListItem[]> {
  const missing = items.filter((i) => !i.thumbnail);
  if (missing.length === 0) return items;

  const ids = missing.map((i) => i.id.split(':')[1]).join(',');
  const url = buildUrl(site.api, { ac: 'detail', ids });
  const cacheKey = `vod:thumbs:${source}:${ids}`;

  const picMap = await cached(cacheKey, async () => {
    const data = await fetchVodApi(url);
    const map = new Map<string, string>();
    for (const vod of data.list ?? []) {
      const pic = normalizePicUrl(vod.vod_pic, site);
      if (pic) map.set(String(vod.vod_id), pic);
    }
    return map;
  });

  return items.map((item) => {
    if (item.thumbnail) return item;
    const vodId = item.id.split(':')[1];
    const pic = picMap.get(vodId);
    return pic ? { ...item, thumbnail: pic } : item;
  });
}

function toListItem(
  source: string,
  sourceName: string,
  vod: VodListItem,
  site: VodSiteConfig,
): MovieListItem {
  const vodId = String(vod.vod_id);
  return {
    id: `${source}:${vodId}`,
    title: vod.vod_name || vodId,
    year: vod.vod_year || '',
    description: truncate(vod.vod_blurb || vod.vod_content || ''),
    thumbnail: normalizePicUrl(vod.vod_pic, site),
    downloads: 0,
    rating: Number(vod.vod_score) || 0,
    subjects: vod.type_name ? [vod.type_name] : [],
    source,
    sourceName,
    remarks: vod.vod_remarks || '',
  };
}

/** MacCMS 线路分隔符（必须用正则，String.split('$$$') 在 JS 中会错误拆分） */
const LINE_SEP = /\$\$\$/;

/** 极速资源等站的 play 页链接补全为 m3u8 */
function normalizeStreamUrl(url: string): string {
  const u = url.trim();
  if (/^https?:\/\/vv\.jisuzyv\.com\/play\/[^/]+$/i.test(u)) {
    return `${u}/index.m3u8`;
  }
  return u;
}

function toPlayableFile(sourceName: string, epName: string, rawUrl: string): PlayableFile | null {
  const name = epName.trim();
  const url = normalizeStreamUrl(rawUrl);
  if (!url.startsWith('http')) return null;
  const isM3u8 = url.includes('.m3u8');
  return {
    name: name ? `${sourceName} · ${name}` : sourceName,
    format: isM3u8 ? 'm3u8' : 'mp4',
    size: 0,
    length: '',
    url,
    mimetype: isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp4',
  };
}

/** 解析单集 token：第N集$url 或 url#第N集 或纯 url */
function parseEpisodeToken(sourceName: string, token: string): PlayableFile | null {
  const ep = token.trim();
  if (!ep) return null;

  const dollarIdx = ep.indexOf('$');
  if (dollarIdx !== -1) {
    return toPlayableFile(sourceName, ep.slice(0, dollarIdx), ep.slice(dollarIdx + 1));
  }

  if (ep.startsWith('http')) {
    const hashIdx = ep.indexOf('#');
    if (hashIdx !== -1) {
      return toPlayableFile(sourceName, ep.slice(hashIdx + 1), ep.slice(0, hashIdx));
    }
    return toPlayableFile(sourceName, '播放', ep);
  }

  return null;
}

/** 去掉无法直接播放的极速 play 页假 mp4（已有同集 m3u8 时） */
function preferStreamableFiles(files: PlayableFile[]): PlayableFile[] {
  const hasM3u8 = files.some((f) => f.format === 'm3u8');
  const filtered = hasM3u8
    ? files.filter((f) => {
        if (f.format === 'm3u8') return true;
        if (/vv\.jisuzyv\.com\/play\//i.test(f.url) && !f.url.includes('.m3u8')) {
          return false;
        }
        return true;
      })
    : files;

  const seen = new Set<string>();
  const deduped: PlayableFile[] = [];
  for (const f of filtered) {
    const key = `${f.url}|${f.name.replace(/^[^·]+ · /, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }
  return deduped;
}

/** 解析 MacCMS 播放地址：vod_play_from + vod_play_url */
export function parsePlayUrls(vod_play_from?: string, vod_play_url?: string): PlayableFile[] {
  if (!vod_play_url) return [];
  const sources = (vod_play_from || '默认线路').split(LINE_SEP);
  const urlGroups = vod_play_url.split(LINE_SEP);
  const files: PlayableFile[] = [];

  for (let i = 0; i < urlGroups.length; i++) {
    const sourceName = sources[i] || `线路${i + 1}`;
    const episodes = urlGroups[i].split('#').filter(Boolean);
    for (const ep of episodes) {
      const file = parseEpisodeToken(sourceName, ep);
      if (file) files.push(file);
    }
  }
  return preferStreamableFiles(files);
}

/** 获取资源站分类标签树 */
export async function getVodCategories(source: string): Promise<VodCategory[]> {
  const site = getVodSite(source);
  if (!site) throw new Error(`未知资源站: ${source}`);

  const url = buildUrl(site.api, { ac: 'list', pg: 1 });
  const cacheKey = `vod:categories:${source}`;

  return cached(cacheKey, async () => {
    const data = await fetchVodApi(url);
    return normalizeCategories(data.class ?? []);
  });
}

/** 部分资源站 class 不含 type_pid，需归一化后前端才能展示标签 */
function normalizeCategories(classList: VodClassItem[]): VodCategory[] {
  if (classList.length === 0) return [];

  const hasHierarchy = classList.some(
    (c) => c.type_pid !== undefined && c.type_pid !== null && c.type_pid > 0,
  );

  if (hasHierarchy) {
    return classList.map((c) => ({
      typeId: c.type_id,
      typePid: c.type_pid ?? 0,
      typeName: c.type_name,
    }));
  }

  // 无层级字段时整表作为一级分类（如最大资源 zuidapi）
  return classList.map((c) => ({
    typeId: c.type_id,
    typePid: 0,
    typeName: c.type_name,
  }));
}

export async function listVodMovies(
  source: string,
  page = 1,
  rows = 24,
  typeId?: number,
): Promise<PaginatedResult<MovieListItem>> {
  const site = getVodSite(source);
  if (!site) throw new Error(`未知资源站: ${source}`);

  const apiParams: Record<string, string | number> = { ac: 'list', pg: page };
  if (typeId) apiParams.t = typeId;
  const url = buildUrl(site.api, apiParams);
  const cacheKey = `vod:list:${source}:${typeId || 'all'}:${page}`;

  return cached(cacheKey, async () => {
    const data = await fetchVodApi(url);
    const list = data.list ?? [];
    const limit = Number(data.limit) || rows;
    const items = await enrichWithThumbnails(
      source,
      site,
      list.map((v) => toListItem(source, site.name, v, site)),
    );
    return {
      items,
      total: data.total ?? list.length,
      page: data.page ?? page,
      rows: limit,
    };
  });
}

function sortSearchItems(items: MovieListItem[]): MovieListItem[] {
  return [...items].sort((a, b) => {
    if (!!a.thumbnail !== !!b.thumbnail) return a.thumbnail ? -1 : 1;
    return a.title.localeCompare(b.title, 'zh-CN');
  });
}

/** 并行搜索全部 VOD 资源站 */
export async function searchAllVodMovies(
  keyword: string,
  page = 1,
  rowsPerSite = GLOBAL_SEARCH_ROWS_PER_SITE,
  maxReturn = 24,
): Promise<GlobalSearchResult> {
  const safe = keyword.trim();
  const sources = listVodSources();
  if (!safe) {
    return {
      items: [],
      total: 0,
      page,
      rows: rowsPerSite,
      sourcesHit: 0,
      sourcesTotal: sources.length,
      hasMore: false,
    };
  }

  const items: MovieListItem[] = [];
  let sourcesHit = 0;
  let hasMore = false;
  let totalSum = 0;

  for (let i = 0; i < sources.length; i += GLOBAL_SEARCH_BATCH) {
    const batch = sources.slice(i, i + GLOBAL_SEARCH_BATCH);
    const settled = await Promise.allSettled(
      batch.map(({ key }) => searchVodMovies(key, safe, page, rowsPerSite)),
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      const { items: batchItems, total } = result.value;
      totalSum += total;
      if (batchItems.length === 0) continue;
      sourcesHit++;
      items.push(...batchItems);
      if (batchItems.length >= rowsPerSite || page * rowsPerSite < total) {
        hasMore = true;
      }
    }
  }

  const sorted = sortSearchItems(items);
  const capped = sorted.slice(0, maxReturn);

  return {
    items: capped,
    total: Math.max(totalSum, capped.length),
    page,
    rows: maxReturn,
    sourcesHit,
    sourcesTotal: sources.length,
    hasMore: hasMore || sorted.length > maxReturn,
  };
}

export async function searchVodMovies(
  source: string,
  keyword: string,
  page = 1,
  rows = 24,
): Promise<PaginatedResult<MovieListItem>> {
  const site = getVodSite(source);
  if (!site) throw new Error(`未知资源站: ${source}`);

  const safe = keyword.trim();
  if (!safe) return listVodMovies(source, page, rows);

  const url = buildUrl(site.api, { ac: 'detail', wd: safe, pg: page });
  const cacheKey = `vod:search:${source}:${safe}:${page}`;

  return cached(cacheKey, async () => {
    const data = await fetchVodApi(url);
    const list = data.list ?? [];
    const limit = Number(data.limit) || rows;
    return {
      items: list.map((v) => toListItem(source, site.name, v, site)),
      total: data.total ?? list.length,
      page: data.page ?? page,
      rows: limit,
    };
  });
}

export async function getVodMovieDetail(source: string, vodId: string): Promise<MovieDetail | null> {
  const site = getVodSite(source);
  if (!site) throw new Error(`未知资源站: ${source}`);

  const url = buildUrl(site.api, { ac: 'detail', ids: vodId });
  const cacheKey = `vod:detail:${source}:${vodId}`;

  return cached(cacheKey, async () => {
    const data = await fetchVodApi(url);
    const vod = data.list?.[0];
    if (!vod) return null;

    const playableFiles = parsePlayUrls(vod.vod_play_from, vod.vod_play_url);

    return {
      id: `${source}:${vodId}`,
      title: vod.vod_name || vodId,
      year: vod.vod_year || '',
      description: truncate(vod.vod_content || vod.vod_blurb || '', 2000),
      thumbnail: normalizePicUrl(vod.vod_pic, site),
      downloads: 0,
      rating: Number(vod.vod_score) || 0,
      subjects: [
        ...(vod.type_name ? [vod.type_name] : []),
        ...(vod.vod_area ? [vod.vod_area] : []),
      ],
      source,
      sourceName: site.name,
      remarks: vod.vod_remarks || '',
      creator: vod.vod_director || '',
      runtime: '',
      language: vod.vod_lang || '',
      licenseUrl: '',
      actor: vod.vod_actor || '',
      playableFiles,
      sourceFiles: playableFiles,
    };
  });
}

/** 解析复合 ID：dyttzy:12345 → { source, vodId } */
export function parseVodId(id: string): { source: string; vodId: string } | null {
  const idx = id.indexOf(':');
  if (idx === -1) return null;
  return { source: id.slice(0, idx), vodId: id.slice(idx + 1) };
}
