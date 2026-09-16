import { useState } from 'react';
import { Link } from 'react-router-dom';
import { proxyImageUrl } from '../utils/imageUrl.js';
import type { MovieListItem } from '../types.js';

interface Props {
  movie: MovieListItem;
  listParams?: string;
}

export default function MovieCard({ movie, listParams }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const [forceDirect, setForceDirect] = useState(false);
  const detailUrl = listParams
    ? `/movie/${movie.id}?${listParams}`
    : `/movie/${movie.id}`;

  const thumbSrc = forceDirect
    ? movie.thumbnail
    : proxyImageUrl(movie.thumbnail);
  const showImg = thumbSrc && !imgFailed;

  function onImgError() {
    if (!forceDirect && movie.thumbnail) {
      setForceDirect(true);
      return;
    }
    setImgFailed(true);
  }

  return (
    <Link to={detailUrl} className="movie-card">
      <div className="poster">
        {showImg ? (
          <img
            src={thumbSrc}
            alt={movie.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={onImgError}
          />
        ) : (
          <div className="poster-placeholder" aria-hidden="true">
            {movie.title.slice(0, 1)}
          </div>
        )}
        {movie.sourceName && (
          <span className="source-badge" title={movie.source}>
            {movie.sourceName}
          </span>
        )}
        {movie.year && <span className="year-badge">{movie.year}</span>}
        {movie.remarks && <span className="remarks-badge">{movie.remarks}</span>}
      </div>
      <div className="card-body">
        <h3 className="card-title" title={movie.title}>
          {movie.title}
        </h3>
        {movie.subjects.length > 0 && (
          <div className="card-subjects">
            {movie.subjects.slice(0, 2).map((s) => (
              <span key={s} className="subject-tag">
                {s}
              </span>
            ))}
          </div>
        )}
        <div className="card-meta">
          {movie.downloads > 0 && <span>⬇ {formatNumber(movie.downloads)}</span>}
          {movie.rating > 0 && <span>★ {movie.rating.toFixed(1)}</span>}
          {movie.sourceName && <span className="source-tag">{movie.sourceName}</span>}
        </div>
      </div>
    </Link>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
