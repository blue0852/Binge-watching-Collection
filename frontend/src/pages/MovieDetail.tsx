import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { usePlayer } from '../player/PlayerProvider.js';
import { fetchMovieDetail } from '../api/client.js';
import { proxyImageUrl } from '../utils/imageUrl.js';
import { buildListUrl } from '../utils/listUrl.js';
import type { MovieDetail } from '../types.js';

/**
 * 播放器停靠位：真正的 <video> 挂在应用层，这里只负责把位置让出来。
 * 这样离开详情页时视频不会卸载，会自动收进右下角小窗。
 */
function PlayerSlot({ movie }: { movie: MovieDetail }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const { open, registerSlot, unregisterSlot, session, mode, restoreInline } = usePlayer();

  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    registerSlot(el);
    open({
      key: movie.id,
      files: movie.playableFiles,
      poster: proxyImageUrl(movie.thumbnail),
      title: movie.title,
      sourceLabel: movie.sourceName,
      historyMeta: {
        id: movie.id,
        thumbnail: movie.thumbnail,
        source: movie.source,
        sourceName: movie.sourceName,
        year: movie.year,
      },
    });
    return () => unregisterSlot(el);
  }, [movie, open, registerSlot, unregisterSlot]);

  const miniHere = mode === 'mini' && session?.key === movie.id;

  return (
    <div ref={slotRef} className={miniHere ? 'player-slot is-mini' : 'player-slot'}>
      {miniHere && (
        <div className="player-slot-hint">
          <span>正在小窗播放，切换页面不影响播放</span>
          <button type="button" className="btn" onClick={restoreInline}>
            还原到页面
          </button>
        </div>
      )}
    </div>
  );
}

export default function MovieDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const backUrl = buildListUrl(searchParams);
  const [movie, setMovie] = useState<MovieDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isArchive = !id?.includes(':');

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMovieDetail(id)
      .then((m) => {
        if (!cancelled) setMovie(m);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>正在加载详情…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-box">
        加载失败：{error}
        <div>
          <Link to={backUrl} className="btn">
            返回列表
          </Link>
        </div>
      </div>
    );
  }

  if (!movie) return null;

  return (
    <div className="detail">
      <div className="detail-back">
        <Link to={backUrl}>← 返回</Link>
      </div>

      <div className="detail-header">
        <h1 className="detail-title">{movie.title}</h1>
        <div className="detail-meta">
          {movie.year && <span>{movie.year}</span>}
          {movie.remarks && <span>{movie.remarks}</span>}
          {movie.runtime && <span>⏱ {movie.runtime}</span>}
          {movie.language && <span>🌐 {movie.language}</span>}
          {movie.creator && <span>🎬 {movie.creator}</span>}
          {movie.actor && <span>👤 {movie.actor}</span>}
          {movie.sourceName && <span>📡 {movie.sourceName}</span>}
        </div>
      </div>

      <PlayerSlot movie={movie} />

      <div className="detail-info">
        <section className="info-section">
          <h2>简介</h2>
          <p className="description">{movie.description || '暂无简介'}</p>
        </section>

        {movie.subjects.length > 0 && (
          <section className="info-section">
            <h2>分类 / 标签</h2>
            <div className="subjects">
              {movie.subjects.map((s) => (
                <span key={s} className="subject-tag">
                  {s}
                </span>
              ))}
            </div>
          </section>
        )}

        {movie.licenseUrl && (
          <section className="info-section">
            <h2>授权</h2>
            <p>
              <a href={movie.licenseUrl} target="_blank" rel="noopener noreferrer">
                {movie.licenseUrl}
              </a>
            </p>
          </section>
        )}

        <section className="info-section">
          <h2>来源</h2>
          <p>
            {isArchive ? (
              <>
                本作品托管于 Internet Archive ·{' '}
                <a
                  href={`https://archive.org/details/${movie.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看原页面
                </a>
              </>
            ) : (
              <>资源站：{movie.sourceName || movie.source || '未知'}</>
            )}
          </p>
        </section>
      </div>
    </div>
  );
}
