// archive.org API 客户端
// 文档：https://archive.org/advancedsearch.php

import fetch from 'node-fetch';
import type {
  ArchiveSearchResponse,
  ArchiveMetadataResponse,
  ArchiveSearchDoc,
  MovieListItem,
  MovieDetail,
  PlayableFile,
  PaginatedResult,
} from '../types.js';

const ARCHIVE_BASE = 'https://archive.org';
const ARCHIVE_TIMEOUT_MS = 30000;
const ARCHIVE_RETRIES = 2;

async function archiveFetch(url: string): Promise<Awaited<ReturnType<typeof fetch>>> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= ARCHIVE_RETRIES; attempt++) {
    try {
      return await fetch(url, {
        timeout: ARCHIVE_TIMEOUT_MS,
        headers: { 'User-Agent': 'PublicDomainCinema/1.0 (archive proxy)' },
      } as never);
    } catch (e) {
      lastError = e as Error;
      if (attempt < ARCHIVE_RETRIES) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error('archive.org 请求失败');
}

/** 将底层网络错误转为用户可读说明 */
export function formatArchiveError(err: Error): string {
  const msg = err.message;
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
    return '无法连接 archive.org（网络超时或被阻断）。请检查网络/代理，或改用国内 VOD 资源站。';
  }
  return msg;
}

/** 简单内存缓存（TTL 5 分钟），减少对 archive.org 的重复请求 */
interface CacheEntry<T> {
  value: T;
  expireAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL = 5 * 60 * 1000;

async function cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expireAt > Date.now()) {
    return hit.value as T;
  }
  const value = await factory();
  cache.set(key, { value, expireAt: Date.now() + CACHE_TTL });
  return value;
}

/** 把 archive.org 的字符串/字符串数组字段统一成字符串 */
function asString(v: string | string[] | undefined): string {
  if (!v) return '';
  return Array.isArray(v) ? v.join(', ') : v;
}

/** 把 archive.org 的字符串/字符串数组字段统一成字符串数组 */
function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : v.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

/** 截断描述到合理长度 */
function truncate(s: string, max = 300): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

/** 列表项规整 */
function toListItem(doc: ArchiveSearchDoc): MovieListItem {
  return {
    id: doc.identifier,
    title: asString(doc.title) || doc.identifier,
    year: asString(doc.year),
    description: truncate(asString(doc.description)),
    thumbnail: `${ARCHIVE_BASE}/services/img/${doc.identifier}`,
    downloads: doc.downloads ?? 0,
    rating: doc.avg_rating ?? 0,
    subjects: asArray(doc.subject).slice(0, 5),
  };
}

/**
 * 搜索公有领域影视
 * 默认在 movies 集合中查 mediatype=movies
 */
export async function searchMovies(
  query: string,
  page = 1,
  rows = 20,
): Promise<PaginatedResult<MovieListItem>> {
  const start = (page - 1) * rows;
  // 限定在 movies 集合、影视类型，且排除一些非视频子集合
  const q = [
    'collection:movies',
    'AND mediatype:movies',
    'AND format:MovingImage',
    query ? `AND (${query})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const url =
    `${ARCHIVE_BASE}/advancedsearch.php?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=description&fl[]=year&fl[]=creator` +
    `&fl[]=subject&fl[]=downloads&fl[]=avg_rating&fl[]=num_reviews` +
    `&sort[]=downloads+desc&output=json&rows=${rows}&page=${page}`;

  const cacheKey = `search:${url}`;
  return cached(cacheKey, async () => {
    const res = await archiveFetch(url);
    if (!res.ok) throw new Error(`archive.org search failed: ${res.status}`);
    const data = (await res.json()) as ArchiveSearchResponse;
    return {
      items: data.response.docs.map(toListItem),
      total: data.response.numFound,
      page,
      rows,
    };
  });
}

/**
 * 按关键词搜索（用户输入的文本）
 * 在 title/description/subject 中匹配
 */
export async function searchByKeyword(
  keyword: string,
  page = 1,
  rows = 20,
): Promise<PaginatedResult<MovieListItem>> {
  // 转义用户输入，构造为 title:"xxx" OR description:"xxx" OR subject:"xxx"
  const safe = keyword.replace(/["\\]/g, '').trim();
  if (!safe) return searchMovies('', page, rows);
  const query = `title:"${safe}" OR description:"${safe}" OR subject:"${safe}"`;
  return searchMovies(query, page, rows);
}

/** 判断文件是否为浏览器可流式播放的视频格式 */
function isPlayableVideo(file: { format?: string; name: string; mimetype?: string }): boolean {
  const format = (file.format || '').toLowerCase();
  const name = file.name.toLowerCase();
  // 优先 h.264 / h264 / mp4
  if (format.includes('h.264') || format.includes('h264') || format === 'mp4' || format === 'mpeg4') {
    return true;
  }
  // 兜底：扩展名为 mp4 且 mimetype 是 video
  if (name.endsWith('.mp4') && (file.mimetype || '').startsWith('video/')) {
    return true;
  }
  // Ogg Theora 也可播放，但优先级低
  if (format.includes('theora') || (name.endsWith('.ogv') && (file.mimetype || '').startsWith('video/'))) {
    return true;
  }
  return false;
}

/** 排序：mp4/h264 优先，然后按分辨率降序 */
function rankPlayable(file: PlayableFile): number {
  const f = file.format.toLowerCase();
  if (f.includes('h.264') || f.includes('h264') || f === 'mp4') return 100;
  if (f.includes('theora')) return 10;
  return 0;
}

/**
 * 获取单部影视详情
 */
export async function getMovieDetail(id: string): Promise<MovieDetail | null> {
  const url = `${ARCHIVE_BASE}/metadata/${encodeURIComponent(id)}`;
  const cacheKey = `meta:${id}`;

  return cached(cacheKey, async () => {
    const res = await archiveFetch(url);
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`archive.org metadata failed: ${res.status}`);
    }
    const data = (await res.json()) as ArchiveMetadataResponse;
    const m = data.metadata;
    const files = data.files ?? [];

    const playableFiles: PlayableFile[] = files
      .filter(isPlayableVideo)
      .map((f) => ({
        name: f.name,
        format: f.format || 'unknown',
        size: Number(f.size || 0),
        length: f.length || '',
        url: `${ARCHIVE_BASE}/download/${id}/${encodeURIComponent(f.name)}`,
        mimetype: f.mimetype || 'video/mp4',
      }))
      .sort((a, b) => rankPlayable(b) - rankPlayable(a));

    // 同时收集一些可下载的源文件（含非视频，如字幕、原始胶片扫描）
    const sourceFiles: PlayableFile[] = files
      .filter((f) => {
        const fmt = (f.format || '').toLowerCase();
        return fmt.includes('h.264') || fmt.includes('h264') || fmt === 'mp4';
      })
      .map((f) => ({
        name: f.name,
        format: f.format || 'unknown',
        size: Number(f.size || 0),
        length: f.length || '',
        url: `${ARCHIVE_BASE}/download/${id}/${encodeURIComponent(f.name)}`,
        mimetype: f.mimetype || 'video/mp4',
      }));

    return {
      id,
      title: asString(m.title) || id,
      year: asString(m.year),
      description: asString(m.description),
      thumbnail: `${ARCHIVE_BASE}/services/img/${id}`,
      downloads: 0,
      rating: 0,
      subjects: asArray(m.subject).slice(0, 10),
      creator: asString(m.creator),
      runtime: asString(m.runtime),
      language: asString(m.language),
      licenseUrl: asString(m.licenseurl),
      playableFiles,
      sourceFiles,
    };
  });
}
