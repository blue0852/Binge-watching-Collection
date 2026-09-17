// 后端 API 客户端

import type {
  CategoriesResponse,
  GlobalSearchResult,
  MovieDetail,
  MovieListItem,
  PaginatedResult,
  SourcesResponse,
} from '../types.js';

const API_BASE = '/api';

async function request<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    const msg = [body.error, body.detail].filter(Boolean).join('：');
    throw new Error(msg || `请求失败: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** 获取可用资源站 */
export function fetchSources(): Promise<SourcesResponse> {
  return request<SourcesResponse>(`${API_BASE}/movies/sources`);
}

/** 获取 VOD 分类标签 */
export function fetchCategories(source: string): Promise<CategoriesResponse> {
  return request<CategoriesResponse>(
    `${API_BASE}/movies/categories?source=${encodeURIComponent(source)}`,
  );
}

/** 获取热门列表 */
export function fetchMovies(
  page = 1,
  rows = 24,
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
  rows = 24,
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
  rows = 24,
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
