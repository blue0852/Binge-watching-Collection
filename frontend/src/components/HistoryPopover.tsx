import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  formatHistoryTime,
  getPlayHistory,
  historyDetailPath,
  historyProgressPercent,
  HISTORY_CHANGED,
  type PlayHistoryEntry,
} from '../utils/playHistory.js';
import { proxyImageUrl } from '../utils/imageUrl.js';

const POPOVER_MAX = 10;

export default function HistoryPopover() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PlayHistoryEntry[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  function reload() {
    setItems(getPlayHistory().slice(0, POPOVER_MAX));
  }

  useEffect(() => {
    reload();
    window.addEventListener(HISTORY_CHANGED, reload);
    return () => window.removeEventListener(HISTORY_CHANGED, reload);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    setOpen((v) => {
      if (!v) reload();
      return !v;
    });
  }

  return (
    <div className="history-popover-wrap" ref={rootRef}>
      <button
        type="button"
        className={`header-nav-btn ${open ? 'active' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        播放历史
        {items.length > 0 && <span className="history-badge">{items.length}</span>}
      </button>
      {open && (
        <div className="history-popover" role="dialog" aria-label="播放历史">
          <div className="history-popover-head">
            <span>最近观看</span>
            <Link to="/history" className="history-popover-more" onClick={() => setOpen(false)}>
              全部
            </Link>
          </div>
          {items.length === 0 ? (
            <p className="history-popover-empty hint">暂无播放记录</p>
          ) : (
            <ul className="history-popover-list">
              {items.map((entry) => {
                const pct = historyProgressPercent(entry);
                const thumb = proxyImageUrl(entry.thumbnail) || entry.thumbnail;
                return (
                  <li key={entry.id}>
                    <Link
                      to={historyDetailPath(entry)}
                      className="history-popover-item"
                      onClick={() => setOpen(false)}
                    >
                      <div className="history-popover-poster">
                        {thumb ? (
                          <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <span>{entry.title.slice(0, 1)}</span>
                        )}
                        {pct != null && pct > 0 && pct < 98 && (
                          <div className="history-progress-bar">
                            <span style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </div>
                      <div className="history-popover-meta">
                        <span className="history-popover-title">{entry.title}</span>
                        <span className="history-popover-sub">
                          {[entry.episodeLabel, entry.sourceName, formatHistoryTime(entry.updatedAt)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
