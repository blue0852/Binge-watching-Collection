import { useState, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import MovieCard from '../components/MovieCard.js';
import CategoryBar from '../components/CategoryBar.js';
import {
  fetchMovies,
  searchMovies,
  searchMoviesGlobal,
  fetchSources,
  fetchCategories,
} from '../api/client.js';
import type { MovieListItem } from '../types.js';

const PAGE_SIZE = 24;

export default function Home() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const query = searchParams.get('q') || '';
  const source = searchParams.get('source') || 'dyttzy';
  const typeId = Number(searchParams.get('type')) || 0;
  const searchScope = searchParams.get('scope') === 'site' ? 'site' : 'global';
  const isGlobalSearch = Boolean(query) && searchScope === 'global';
  const isSiteSearch = Boolean(query) && searchScope === 'site';

  const [items, setItems] = useState<MovieListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [sourceName, setSourceName] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [sourcesHit, setSourcesHit] = useState(0);
  const [sourcesTotal, setSourcesTotal] = useState(0);

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
    setItems([]);
    setPage(1);
    setHasMore(true);
  }, [query, source, typeId, searchScope]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const onDone = () => {
      if (!cancelled) setLoading(false);
    };

    if (isGlobalSearch) {
      searchMoviesGlobal(query, page)
        .then((res) => {
          if (cancelled) return;
          setItems((prev) => (page === 1 ? res.items : [...prev, ...res.items]));
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
          setItems((prev) => (page === 1 ? res.items : [...prev, ...res.items]));
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
          setItems((prev) => (page === 1 ? res.items : [...prev, ...res.items]));
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
    return p.toString();
  }, [source, typeId]);

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

      {hasMore && !loading && items.length > 0 && (
        <div className="load-more">
          <button className="btn btn-primary" onClick={() => setPage((p) => p + 1)}>
            加载更多
          </button>
        </div>
      )}

      {!hasMore && items.length > 0 && (
        <p className="end-text">— 已展示全部结果 —</p>
      )}
    </div>
  );
}
