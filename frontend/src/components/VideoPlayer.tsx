import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Hls from 'hls.js';
import Pagination from './Pagination.js';
import type { PlayableFile } from '../types.js';

const EPISODES_PER_PAGE = 24;

interface Props {
  files: PlayableFile[];
  poster?: string;
  title: string;
  sourceLabel?: string;
}

function lineKey(f: PlayableFile): string {
  const i = f.name.indexOf(' · ');
  return i === -1 ? '播放' : f.name.slice(0, i);
}

function episodeLabel(f: PlayableFile): string {
  const i = f.name.indexOf(' · ');
  return i === -1 ? f.name : f.name.slice(i + 3);
}

export default function VideoPlayer({ files, poster, title, sourceLabel }: Props) {
  const [activeLine, setActiveLine] = useState('');
  const [current, setCurrent] = useState<PlayableFile | null>(null);
  const [error, setError] = useState(false);
  const [continuousPlay, setContinuousPlay] = useState(true);
  const [epPage, setEpPage] = useState(1);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const lineGroups = useMemo(() => {
    const map = new Map<string, PlayableFile[]>();
    for (const f of files) {
      const key = lineKey(f);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return map;
  }, [files]);

  const lineNames = useMemo(() => [...lineGroups.keys()], [lineGroups]);

  const lineFiles = useMemo(() => {
    const key = activeLine || lineNames[0] || '';
    return lineGroups.get(key) ?? [];
  }, [lineGroups, activeLine, lineNames]);

  useEffect(() => {
    if (lineNames.length === 0) return;
    setActiveLine((prev) => (prev && lineGroups.has(prev) ? prev : lineNames[0]));
  }, [lineNames, lineGroups]);

  useEffect(() => {
    if (lineFiles.length > 0) {
      setCurrent((prev) => {
        if (prev && lineFiles.some((f) => f.url === prev.url)) return prev;
        const preferred =
          lineFiles.find((f) => f.format === 'm3u8' || f.url.includes('.m3u8')) ??
          lineFiles[0];
        return preferred;
      });
      setError(false);
      setEpPage(1);
    }
  }, [lineFiles]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !current) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isM3u8 =
      current.format === 'm3u8' ||
      current.url.includes('.m3u8') ||
      current.mimetype.includes('mpegurl');

    if (isM3u8 && Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(current.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(true);
      });
    } else if (isM3u8 && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = current.url;
    } else {
      video.src = current.url;
    }

    void video.play().catch(() => {});

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [current]);

  const currentIndex = useMemo(() => {
    if (!current) return -1;
    return lineFiles.findIndex((f) => f.url === current.url);
  }, [current, lineFiles]);

  const goToEpisodeIndex = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= lineFiles.length) return;
      setCurrent(lineFiles[idx]);
      setError(false);
      setEpPage(Math.floor(idx / EPISODES_PER_PAGE) + 1);
    },
    [lineFiles],
  );

  const playPrevEpisode = useCallback(() => {
    if (currentIndex > 0) goToEpisodeIndex(currentIndex - 1);
  }, [currentIndex, goToEpisodeIndex]);

  const playNextEpisode = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < lineFiles.length - 1) {
      goToEpisodeIndex(currentIndex + 1);
    }
  }, [currentIndex, lineFiles.length, goToEpisodeIndex]);

  function onVideoEnded() {
    if (continuousPlay) playNextEpisode();
  }

  function switchFile(f: PlayableFile) {
    const idx = lineFiles.findIndex((x) => x.url === f.url);
    if (idx >= 0) goToEpisodeIndex(idx);
  }

  function onLineChange(line: string) {
    setActiveLine(line);
    setEpPage(1);
  }

  if (files.length === 0) {
    return (
      <div className="player player-empty">
        <p>⚠ 暂无可用播放地址</p>
        <p className="hint">该资源可能尚未更新或当前线路不可用，请尝试切换其他资源站</p>
      </div>
    );
  }

  const epTotalPages = Math.max(1, Math.ceil(lineFiles.length / EPISODES_PER_PAGE));
  const epStart = (epPage - 1) * EPISODES_PER_PAGE;
  const visibleEpisodes = lineFiles.slice(epStart, epStart + EPISODES_PER_PAGE);

  return (
    <div className="player">
      <div className="player-video">
        {error ? (
          <div className="player-error">
            <p>⚠ 视频加载失败</p>
            <p className="hint">可能是网络问题或该线路暂时不可用，请尝试切换其他线路</p>
            <button className="btn" onClick={() => setError(false)}>
              重试
            </button>
          </div>
        ) : (
          current && (
            <video
              ref={videoRef}
              controls
              autoPlay
              playsInline
              poster={poster}
              preload="metadata"
              onError={() => setError(true)}
              onEnded={onVideoEnded}
            >
              您的浏览器不支持 HTML5 视频播放。
            </video>
          )
        )}
      </div>

      <div className="player-episode-nav">
        <button
          type="button"
          className="btn btn-episode-nav"
          disabled={currentIndex <= 0}
          onClick={playPrevEpisode}
        >
          上一集
        </button>
        {current && lineFiles.length > 1 && (
          <span className="now-playing-ep">
            {episodeLabel(current)}（{currentIndex + 1}/{lineFiles.length}）
          </span>
        )}
        {current && lineFiles.length <= 1 && (
          <span className="now-playing-ep">{episodeLabel(current)}</span>
        )}
        <button
          type="button"
          className="btn btn-episode-nav"
          disabled={currentIndex < 0 || currentIndex >= lineFiles.length - 1}
          onClick={playNextEpisode}
        >
          下一集
        </button>
      </div>

      <div className="player-options">
        <label className="continuous-toggle">
          <input
            type="checkbox"
            checked={continuousPlay}
            onChange={(e) => setContinuousPlay(e.target.checked)}
          />
          连续播放（播完自动下一集）
        </label>
      </div>

      {lineNames.length > 1 && (
        <div className="player-lines">
          <span className="sources-label">线路：</span>
          <div className="sources-list">
            {lineNames.map((line) => (
              <button
                key={line}
                type="button"
                className={`source-btn ${activeLine === line ? 'active' : ''}`}
                onClick={() => onLineChange(line)}
              >
                {line}
              </button>
            ))}
          </div>
        </div>
      )}

      {lineFiles.length > 1 && (
        <div className="player-sources">
          <span className="sources-label">选集：</span>
          <div className="sources-list">
            {visibleEpisodes.map((f) => (
              <button
                key={f.name + f.url}
                type="button"
                className={`source-btn ${current?.url === f.url ? 'active' : ''}`}
                onClick={() => switchFile(f)}
                title={f.name}
              >
                {episodeLabel(f)}
              </button>
            ))}
          </div>
          {lineFiles.length > EPISODES_PER_PAGE && (
            <Pagination
              page={epPage}
              totalPages={epTotalPages}
              onPageChange={setEpPage}
            />
          )}
        </div>
      )}

      <p className="player-credit">
        正在播放「{title}」{sourceLabel ? ` · ${sourceLabel}` : ''}
      </p>
    </div>
  );
}
