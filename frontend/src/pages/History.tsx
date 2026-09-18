import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  clearPlayHistory,
  formatHistoryTime,
  getPlayHistory,
  historyDetailPath,
  historyProgressPercent,
  HISTORY_CHANGED,
  removePlayHistory,
  type PlayHistoryEntry,
} from '../utils/playHistory.js';
import { proxyImageUrl } from '../utils/imageUrl.js';

export default function HistoryPage() {
  const [items, setItems] = useState<PlayHistoryEntry[]>([]);

  function reload() {
    setItems(getPlayHistory());
  }

  useEffect(() => {
    reload();
    window.addEventListener(HISTORY_CHANGED, reload);
    return () => window.removeEventListener(HISTORY_CHANGED, reload);
  }, []);

  function onClearAll() {
    if (!window.confirm('确定清空全部播放历史？')) return;
    clearPlayHistory();
  }

  function onRemove(id: string, title: string) {
    if (!window.confirm(`从历史中移除「${title}」？`)) return;
    removePlayHistory(id);
  }

  return (
    <div className="history-page">
      <div className="history-header">
        <h1 className="history-title">播放历史</h1>
        {items.length > 0 && (
          <button type="button" className="btn btn-danger btn-sm" onClick={onClearAll}>
            清空历史
          </button>
        )}
      </div>
      <p className="hint history-desc">记录保存在本浏览器，换设备或清理站点数据后会丢失。</p>

      {items.length === 0 ? (
        <div className="empty">
          <p>暂无播放记录</p>
          <Link to="/" className="btn">
            去首页看看
          </Link>
        </div>
      ) : (
        <ul className="history-list">
          {items.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} onRemove={() => onRemove(entry.id, entry.title)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({ entry, onRemove }: { entry: PlayHistoryEntry; onRemove: () => void }) {
  const pct = historyProgressPercent(entry);
  const thumb = proxyImageUrl(entry.thumbnail) || entry.thumbnail;

  return (
    <li className="history-item">
      <Link to={historyDetailPath(entry)} className="history-item-link">
        <div className="history-poster">
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
        <div className="history-item-body">
          <h3 className="history-item-title">{entry.title}</h3>
          <p className="history-item-meta">
            {entry.episodeLabel && <span>{entry.episodeLabel}</span>}
            {entry.sourceName && <span>{entry.sourceName}</span>}
            {entry.year && <span>{entry.year}</span>}
            <span>{formatHistoryTime(entry.updatedAt)}</span>
          </p>
          {pct != null && pct > 0 && pct < 98 && (
            <p className="hint">续播 · 已看 {pct}%</p>
          )}
        </div>
      </Link>
      <button type="button" className="btn btn-sm history-remove" onClick={onRemove} aria-label="移除">
        移除
      </button>
    </li>
  );
}
