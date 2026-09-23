// 后端 API 客户端

import type {
  CategoriesResponse,
  GlobalSearchResult,
  MovieDetail,
  MovieListItem,
  PaginatedResult,
  SourceLatencyResponse,
  SourcesResponse,
  VodSiteEntry,
  VodSitesResponse,
} from '../types.js';

const API_BASE = '/api';

/** 短 TTL 去重，避免切换站点时 Home / CategoryBar 重复打同一接口 */
const clientCache = new Map<string, { expireAt: number; value: Promise<unknown> }>();

function cachedGet<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = clientCache.get(key);
  if (hit && hit.expireAt > now) return hit.value as Promise<T>;
  const value = factory();
  clientCache.set(key, { expireAt: now + ttlMs, value });
  value.catch(() => {
    const cur = clientCache.get(key);
    if (cur?.value === value) clientCache.delete(key);
  });
  if (clientCache.size > 80) {
    for (const [k, entry] of clientCache) {
      if (entry.expireAt <= now) clientCache.delete(k);
    }
  }
  return value;
}

/** 清空前端短 TTL 请求缓存 */
export function clearClientCache(): void {
  clientCache.clear();
}

/** 清空服务端 API 内存缓存并重新拉取 config */
export function refreshServerCache(): Promise<{ ok: boolean; cleared: number }> {
  return request<{ ok: boolean; cleared: number }>(`${API_BASE}/cache/refresh`, {
    method: 'POST',
  });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    const err = body.error?.trim();
    const detail = body.detail?.trim();
    let msg: string;
    if (err && detail) {
      msg = detail.startsWith(err) ? detail : `${err}：${detail}`;
    } else {
      msg = detail || err || `请求失败: ${res.status}`;
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/** 获取可用资源站 */
export function fetchSources(): Promise<SourcesResponse> {
  return cachedGet('sources', 60_000, () =>
    request<SourcesResponse>(`${API_BASE}/movies/sources`),
  );
}

/** 各资源站连接延迟（后端约 60s 缓存） */
export function fetchSourceLatencies(): Promise<SourceLatencyResponse> {
  return cachedGet('sources-latency', 55_000, () =>
    request<SourceLatencyResponse>(`${API_BASE}/movies/sources/latency`),
  );
}

/** VOD 站点列表（含 api 地址，用于管理页） */
export function fetchVodSites(): Promise<VodSitesResponse> {
  return request<VodSitesResponse>(`${API_BASE}/movies/sites`);
}

/** 新增 VOD 站点 */
export function addVodSite(site: VodSiteEntry): Promise<VodSitesResponse> {
  return request<VodSitesResponse>(`${API_BASE}/movies/sites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(site),
  });
}

/** 删除 VOD 站点 */
export function deleteVodSite(key: string): Promise<VodSitesResponse> {
  return request<VodSitesResponse>(
    `${API_BASE}/movies/sites/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );
}

/** 获取 VOD 分类标签 */
export function fetchCategories(source: string): Promise<CategoriesResponse> {
  return cachedGet(`categories:${source}`, 120_000, () =>
    request<CategoriesResponse>(
      `${API_BASE}/movies/categories?source=${encodeURIComponent(source)}`,
    ),
  );
}

/** 获取热门列表 */
export function fetchMovies(
  page = 1,
  rows = 20,
  source?: string,
  typeId?: number,
): Promise<PaginatedResult<MovieListItem>> {
  const params = new URLSearchParams({ page: String(page), rows: String(rows) });
  if (source) params.set('source', source);
  if (typeId) params.set('type', String(typeId));
  return request<PaginatedResult<MovieListItem>>(`${API_BASE}/movies?${params}`);
}

/** 全站聚合搜索 */
export function searchMoviesGlobal(
  q: string,
  page = 1,
  rows = 20,
): Promise<GlobalSearchResult> {
  const params = new URLSearchParams({
    q,
    page: String(page),
    rows: String(rows),
  });
  return request<GlobalSearchResult>(
    `${API_BASE}/movies/search/global?${params}`,
  );
}

/** 关键词搜索（单站） */
export function searchMovies(
  q: string,
  page = 1,
  rows = 20,
  source?: string,
): Promise<PaginatedResult<MovieListItem>> {
  const params = new URLSearchParams({
    q,
    page: String(page),
    rows: String(rows),
  });
  if (source) params.set('source', source);
  return request<PaginatedResult<MovieListItem>>(
    `${API_BASE}/movies/search?${params}`,
  );
}

/** 获取详情 */
export function fetchMovieDetail(id: string): Promise<MovieDetail> {
  return request<MovieDetail>(`${API_BASE}/movies/${encodeURIComponent(id)}`);
}
