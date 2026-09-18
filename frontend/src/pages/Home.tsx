import { useState, useEffect, useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import MovieCard from '../components/MovieCard.js';
import CategoryBar from '../components/CategoryBar.js';
import Pagination from '../components/Pagination.js';
import {
  fetchMovies,
  searchMovies,
  searchMoviesGlobal,
  fetchSources,
  fetchCategories,
} from '../api/client.js';
import type { MovieListItem } from '../types.js';
import {
  formatHistoryTime,
  getPlayHistory,
  historyDetailPath,
  historyProgressPercent,
  HISTORY_CHANGED,
  type PlayHistoryEntry,
} from '../utils/playHistory.js';
import { proxyImageUrl } from '../utils/imageUrl.js';

const PAGE_SIZE = 20;
const CONTINUE_MAX = 5;

export default function Home() {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const query = searchParams.get('q') || '';
  const source = searchParams.get('source') || 'dyttzy';
  const typeId = Number(searchParams.get('type')) || 0;
  const searchScope = searchParams.get('scope') === 'site' ? 'site' : 'global';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const isGlobalSearch = Boolean(query) && searchScope === 'global';
  const isSiteSearch = Boolean(query) && searchScope === 'site';

  const [items, setItems] = useState<MovieListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [sourceName, setSourceName] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [sourcesHit, setSourcesHit] = useState(0);
  const [sourcesTotal, setSourcesTotal] = useState(0);
  const [continueItems, setContinueItems] = useState<PlayHistoryEntry[]>([]);

  function refreshContinue() {
    setContinueItems(getPlayHistory().slice(0, CONTINUE_MAX));
  }

  useEffect(() => {
    refreshContinue();
    window.addEventListener(HISTORY_CHANGED, refreshContinue);
    return () => window.removeEventListener(HISTORY_CHANGED, refreshContinue);
  }, []);

  function goToPage(nextPage: number) {
    const params = new URLSearchParams(location.search);
    if (nextPage <= 1) params.delete('page');
    else params.set('page', String(nextPage));
    const qs = params.toString();
    navigate(qs ? `/?${qs}` : '/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  useEffect(() => {
    fetchSources().then((res) => {
      const found = res.sources.find((s) => s.key === source);
      setSourceName(found?.name || source);
    });
  }, [source]);

  useEffect(() => {
    if (!typeId || source === 'archive') {
      setCategoryName('');
      return;
    }
    fetchCategories(source).then((res) => {
      const found = res.categories.find((c) => c.typeId === typeId);
      setCategoryName(found?.typeName || '');
    });
  }, [source, typeId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const onDone = () => {
      if (!cancelled) setLoading(false);
    };

    if (isGlobalSearch) {
      searchMoviesGlobal(query, page, PAGE_SIZE)
        .then((res) => {
          if (cancelled) return;
          setItems(res.items);
          setTotal(res.total);
          setSourcesHit(res.sourcesHit);
          setSourcesTotal(res.sourcesTotal);
          setHasMore(res.hasMore);
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        })
        .finally(onDone);
    } else if (isSiteSearch) {
      searchMovies(query, page, PAGE_SIZE, source)
        .then((res) => {
          if (cancelled) return;
          setItems(res.items);
          setTotal(res.total);
          setSourcesHit(0);
          setSourcesTotal(0);
          setHasMore(page * PAGE_SIZE < res.total);
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        })
        .finally(onDone);
    } else {
      fetchMovies(page, PAGE_SIZE, source, typeId || undefined)
        .then((res) => {
          if (cancelled) return;
          setItems(res.items);
          setTotal(res.total);
          setHasMore(page * PAGE_SIZE < res.total);
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        })
        .finally(onDone);
    }

    return () => {
      cancelled = true;
    };
  }, [query, page, source, typeId, isGlobalSearch, isSiteSearch]);

  const isArchive = source === 'archive';

  const totalPages = useMemo(() => {
    const fromTotal = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (isGlobalSearch && hasMore) {
      return Math.max(fromTotal, page + 1);
    }
    return fromTotal;
  }, [isGlobalSearch, hasMore, page, total]);

  const heading = useMemo(() => {
    if (isGlobalSearch) {
      const hit =
        sourcesHit > 0
          ? ` · 来自 ${sourcesHit}/${sourcesTotal} 个资源站`
          : '';
      return `全站搜索：${query}${hit}`;
    }
    if (isSiteSearch) {
      return `本站搜索：${query} · ${sourceName}`;
    }
    if (isArchive) return '热门公有领域影视';
    if (categoryName) return `${categoryName} · ${sourceName}`;
    return `最新影视 · ${sourceName}`;
  }, [
    isGlobalSearch,
    isSiteSearch,
    query,
    isArchive,
    categoryName,
    sourceName,
    sourcesHit,
    sourcesTotal,
  ]);

  const listUrlParams = useMemo(() => {
    const p = new URLSearchParams();
    if (source) p.set('source', source);
    if (typeId) p.set('type', String(typeId));
    if (page > 1) p.set('page', String(page));
    return p.toString();
  }, [source, typeId, page]);

  return (
    <div className="home">
      <section className="hero">
        <h1 className="hero-title">{isArchive ? '公有领域影视库' : '在线影视'}</h1>
        <p className="hero-sub">
          {isGlobalSearch
            ? `已在全部资源站中搜索「${query}」，每条结果标注所属站点`
            : isSiteSearch
              ? `仅在「${sourceName}」内搜索「${query}」`
              : isArchive
                ? `聚合 Internet Archive 上 ${total.toLocaleString()} 部可合法免费观看的影视作品`
                : `当前资源站：${sourceName} · 共 ${total.toLocaleString()} 条结果`}
        </p>
      </section>

      {!query && continueItems.length > 0 && (
        <section className="continue-section">
          <div className="continue-head">
            <h2>继续观看</h2>
            <Link to="/history">全部历史</Link>
          </div>
          <div className="continue-grid">
            {continueItems.map((entry) => {
              const pct = historyProgressPercent(entry);
              const thumb = proxyImageUrl(entry.thumbnail) || entry.thumbnail;
              return (
                <Link key={entry.id} to={historyDetailPath(entry)} className="continue-card">
                  <div className="continue-poster">
                    {thumb ? (
                      <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="poster-placeholder">{entry.title.slice(0, 1)}</div>
                    )}
                    {pct != null && pct > 0 && pct < 98 && (
                      <div className="history-progress-bar">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="continue-body">
                    <h3 title={entry.title}>{entry.title}</h3>
                    <p>
                      {entry.episodeLabel ? `${entry.episodeLabel} · ` : ''}
                      {formatHistoryTime(entry.updatedAt)}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {!query && <CategoryBar source={source} />}

      <h2 className="section-title">{heading}</h2>

      {error && (
        <div className="error-box">
          加载失败：{error}
          <p className="hint" style={{ marginTop: 8 }}>
            {source === 'archive'
              ? 'Internet Archive 在国内常无法直连，建议切换到「电影天堂」等 VOD 资源站。'
              : '该资源站可能暂时不可用，请尝试切换其他资源站（如电影天堂、360资源）'}
          </p>
        </div>
      )}

      {items.length === 0 && !loading && !error && (
        <div className="empty">没有找到相关作品，试试其他关键词或切换分类</div>
      )}

      <div className="movie-grid">
        {items.map((m) => {
          const cardParams = query
            ? new URLSearchParams({
                q: query,
                scope: searchScope,
                ...(page > 1 ? { page: String(page) } : {}),
                ...(isGlobalSearch && m.source
                  ? { source: m.source }
                  : { source }),
              }).toString()
            : listUrlParams;
          return <MovieCard key={m.id} movie={m} listParams={cardParams} />;
        })}
      </div>

      {loading && (
        <div className="loading">
          <div className="spinner" />
          <p>正在加载…</p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={goToPage}
          disabled={loading}
        />
      )}

      {!loading && items.length > 0 && page >= totalPages && !hasMore && (
        <p className="end-text">— 已展示全部结果 —</p>
      )}
    </div>
  );
}
