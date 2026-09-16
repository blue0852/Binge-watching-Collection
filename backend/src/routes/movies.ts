// 影视相关路由

import { Router } from 'express';
import { listVodSources } from '../config.js';
import {
  searchMovies,
  searchByKeyword,
  getMovieDetail,
  formatArchiveError,
} from '../services/archiveApi.js';
import {
  listVodMovies,
  searchVodMovies,
  searchAllVodMovies,
  getVodMovieDetail,
  getVodCategories,
  parseVodId,
} from '../services/vodApi.js';
import type { GlobalSearchResult, MovieListItem, SourceInfo } from '../types.js';

export const moviesRouter = Router();

const ARCHIVE_SOURCE = 'archive';
const DEFAULT_VOD_SOURCE = 'dyttzy';

function resolveSource(raw: unknown): string {
  const s = String(raw || '').trim();
  return s || DEFAULT_VOD_SOURCE;
}

function isArchiveSource(source: string): boolean {
  return source === ARCHIVE_SOURCE;
}

function upstreamErrorDetail(source: string, err: Error): string {
  if (isArchiveSource(source)) return formatArchiveError(err);
  return err.message;
}

/**
 * GET /api/movies/sources
 * 可用资源站列表
 */
moviesRouter.get('/sources', (_req, res) => {
  const vodSources: SourceInfo[] = listVodSources().map((s) => ({
    key: s.key,
    name: s.name,
    type: 'vod' as const,
  }));
  const sources: SourceInfo[] = [
    { key: ARCHIVE_SOURCE, name: 'Internet Archive', type: 'archive' },
    ...vodSources,
  ];
  res.json({ sources, defaultSource: DEFAULT_VOD_SOURCE });
});

/**
 * GET /api/movies/categories?source=dyttzy
 * VOD 分类标签
 */
moviesRouter.get('/categories', async (req, res) => {
  try {
    const source = resolveSource(req.query.source);
    if (isArchiveSource(source)) {
      res.json({ categories: [] });
      return;
    }
    const categories = await getVodCategories(source);
    res.json({ categories });
  } catch (e) {
    res.status(502).json({ error: '获取分类失败', detail: (e as Error).message });
  }
});

function parseTypeId(raw: unknown): number | undefined {
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

/**
 * GET /api/movies?page=1&rows=24&source=dyttzy
 * 热门/最新列表
 */
moviesRouter.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const rows = Math.min(48, Math.max(1, Number(req.query.rows) || 24));
    const source = resolveSource(req.query.source);
    const typeId = parseTypeId(req.query.type);

    if (isArchiveSource(source)) {
      const result = await searchMovies('', page, rows);
      res.json(result);
      return;
    }

    const result = await listVodMovies(source, page, rows, typeId);
    res.json(result);
  } catch (e) {
    const source = resolveSource(req.query.source);
    res.status(502).json({
      error: '上游请求失败',
      detail: upstreamErrorDetail(source, e as Error),
    });
  }
});

/**
 * GET /api/movies/search/global?q=keyword&page=1
 * 全站聚合搜索（所有 VOD 资源站 + Internet Archive）
 */
moviesRouter.get('/search/global', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);

    if (!q) {
      const sourcesTotal = listVodSources().length;
      res.json({
        items: [],
        total: 0,
        page: 1,
        rows: 0,
        sourcesHit: 0,
        sourcesTotal,
        hasMore: false,
      } satisfies GlobalSearchResult);
      return;
    }

    const [vodResult, archiveResult] = await Promise.all([
      searchAllVodMovies(q, page),
      searchByKeyword(q, page, 8).catch(() => null),
    ]);

    let items: MovieListItem[] = [...vodResult.items];
    let hasMore = vodResult.hasMore;

    if (archiveResult && archiveResult.items.length > 0) {
      const archiveItems = archiveResult.items.map((item) => ({
        ...item,
        source: ARCHIVE_SOURCE,
        sourceName: 'Internet Archive',
      }));
      items = [...archiveItems, ...items].sort((a, b) => {
        if (!!a.thumbnail !== !!b.thumbnail) return a.thumbnail ? -1 : 1;
        return a.title.localeCompare(b.title, 'zh-CN');
      });
      if (page * archiveResult.rows < archiveResult.total) {
        hasMore = true;
      }
    }

    const sourcesHit = vodResult.sourcesHit + (archiveResult?.items.length ? 1 : 0);

    res.json({
      items,
      total: items.length,
      page,
      rows: vodResult.rows,
      sourcesHit,
      sourcesTotal: vodResult.sourcesTotal + 1,
      hasMore,
    } satisfies GlobalSearchResult);
  } catch (e) {
    res.status(502).json({
      error: '全站搜索失败',
      detail: (e as Error).message,
    });
  }
});

/**
 * GET /api/movies/search?q=keyword&page=1&source=dyttzy
 * 关键词搜索（单站）
 */
moviesRouter.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const rows = Math.min(48, Math.max(1, Number(req.query.rows) || 24));
    const source = resolveSource(req.query.source);

    if (isArchiveSource(source)) {
      const result = await searchByKeyword(q, page, rows);
      res.json(result);
      return;
    }

    const result = await searchVodMovies(source, q, page, rows);
    res.json(result);
  } catch (e) {
    const source = resolveSource(req.query.source);
    res.status(502).json({
      error: '上游请求失败',
      detail: upstreamErrorDetail(source, e as Error),
    });
  }
});

/**
 * GET /api/movies/:id
 * 单部影视详情（archive id 或 vod 复合 id 如 dyttzy:12345）
 */
moviesRouter.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const parsed = parseVodId(id);

    if (parsed) {
      const detail = await getVodMovieDetail(parsed.source, parsed.vodId);
      if (!detail) {
        res.status(404).json({ error: '未找到该作品' });
        return;
      }
      res.json(detail);
      return;
    }

    const detail = await getMovieDetail(id);
    if (!detail) {
      res.status(404).json({ error: '未找到该作品' });
      return;
    }
    res.json(detail);
  } catch (e) {
    res.status(502).json({ error: '上游请求失败', detail: (e as Error).message });
  }
});
