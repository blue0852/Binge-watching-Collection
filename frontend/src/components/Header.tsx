import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, type FormEvent } from 'react';
import { clearClientCache, fetchSourceLatencies, fetchSources, refreshServerCache } from '../api/client.js';
import HistoryPopover from './HistoryPopover.js';
import SourceSelect from './SourceSelect.js';
import type { SourceInfo } from '../types.js';

export type SearchScope = 'global' | 'site';

function parseSearchScope(raw: string | null): SearchScope {
  return raw === 'site' ? 'site' : 'global';
}

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState('');
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [source, setSource] = useState('dyttzy');
  const [searchScope, setSearchScope] = useState<SearchScope>('global');
  const [refreshing, setRefreshing] = useState(false);
  const [latencies, setLatencies] = useState<Record<string, number | null>>({});
  const [latencyLoading, setLatencyLoading] = useState(false);

  useEffect(() => {
    fetchSources()
      .then((res) => {
        setSources(res.sources);
        const params = new URLSearchParams(location.search);
        const urlSource = params.get('source');
        setSource(urlSource || res.defaultSource);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (sources.length === 0) return;
    let cancelled = false;
    setLatencyLoading(true);
    fetchSourceLatencies()
      .then((res) => {
        if (!cancelled) setLatencies(res.latencies);
      })
      .catch(() => {
        if (!cancelled) setLatencies({});
      })
      .finally(() => {
        if (!cancelled) setLatencyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sources.length]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setQ(params.get('q') || '');
    setSearchScope(parseSearchScope(params.get('scope')));
    const urlSource = params.get('source');
    if (urlSource) setSource(urlSource);
  }, [location.search]);

  function buildUrl(
    nextQ: string,
    nextSource: string,
    keepType = false,
    scope: SearchScope = searchScope,
  ): string {
    const params = new URLSearchParams();
    if (nextSource) params.set('source', nextSource);
    params.delete('page');
    if (nextQ) {
      params.set('q', nextQ);
      params.set('scope', scope);
    }
    if (keepType) {
      const type = new URLSearchParams(location.search).get('type');
      if (type) params.set('type', type);
    }
    const qs = params.toString();
    return qs ? `/?${qs}` : '/';
  }

  function exitSearch() {
    navigate(buildUrl('', source, true));
  }

  function onSearchInputChange(value: string) {
    setQ(value);
    if (!value.trim() && new URLSearchParams(location.search).get('q')) {
      exitSearch();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed) {
      navigate(buildUrl(trimmed, source, false, searchScope));
      return;
    }
    exitSearch();
  }

  function onScopeChange(next: SearchScope) {
    setSearchScope(next);
    const trimmed = q.trim();
    if (!trimmed) return;
    navigate(buildUrl(trimmed, source, false, next));
  }

  async function onRefreshCache() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshServerCache();
      clearClientCache();
      window.location.reload();
    } catch {
      setRefreshing(false);
    }
  }

  function onSourceChange(next: string) {
    setSource(next);
    const params = new URLSearchParams(location.search);
    const currentQ = params.get('q')?.trim();
    if (currentQ) {
      params.set('source', next);
      params.delete('page');
      navigate(`/?${params.toString()}`);
      return;
    }
    navigate(buildUrl('', next));
  }

  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="logo">
          <span className="logo-mark">🎬</span>
          <span className="logo-text">Public Domain Cinema</span>
        </Link>
        <div className="header-controls">
          <HistoryPopover />
          <Link to="/sites" className="header-nav-link">
            站点管理
          </Link>
          <button
            type="button"
            className="header-refresh-btn"
            onClick={() => void onRefreshCache()}
            disabled={refreshing}
            title="刷新缓存并重新加载"
            aria-label="刷新缓存并重新加载"
          >
            <span className={`header-refresh-icon${refreshing ? ' spinning' : ''}`} aria-hidden="true">
              ↻
            </span>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          {sources.length > 0 && (
            <SourceSelect
              sources={sources}
              value={source}
              latencies={latencies}
              latencyLoading={latencyLoading}
              onChange={onSourceChange}
            />
          )}
          <select
            className="search-scope-select"
            value={searchScope}
            onChange={(e) => onScopeChange(e.target.value as SearchScope)}
            aria-label="搜索范围"
          >
            <option value="global">全站</option>
            <option value="site">本站</option>
          </select>
          <form className="search-form" onSubmit={onSubmit} role="search">
            <input
              type="search"
              className="search-input"
              placeholder="搜索电影 / 关键词…"
              value={q}
              onChange={(e) => onSearchInputChange(e.target.value)}
              aria-label="搜索影视"
            />
            <button type="submit" className="search-btn">
              搜索
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
