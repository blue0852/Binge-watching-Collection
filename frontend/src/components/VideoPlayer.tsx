import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Hls from 'hls.js';
import Pagination from './Pagination.js';
import { getHistoryEntry, upsertPlayHistory } from '../utils/playHistory.js';
import { getPlayerSettings, savePlayerSettings } from '../utils/playerSettings.js';
import { proxyStreamUrl } from '../utils/streamUrl.js';
import type { PlayableFile } from '../types.js';

const EPISODES_PER_PAGE = 20;
const SEEK_STEP_SECONDS = 10;

/** HLS 缓冲与预加载，减轻代理链路下的卡顿 */
const HLS_PLAYER_CONFIG: Partial<Hls['config']> = {
  enableWorker: true,
  startFragPrefetch: true,
  maxBufferLength: 30,
  maxMaxBufferLength: 120,
  maxBufferSize: 80 * 1000 * 1000,
  maxBufferHole: 0.5,
  backBufferLength: 60,
};

function IconPrev() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
    </svg>
  );
}

function IconNext() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="currentColor" d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="currentColor" d="M8 5v14l11-7L8 5z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="currentColor" d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
    </svg>
  );
}

function IconFullscreenEnter() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
      />
    </svg>
  );
}

function IconFullscreenExit() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
      />
    </svg>
  );
}

function getFullscreenElement(): Element | null {
  const doc = document as Document & {
    webkitFullscreenElement?: Element | null;
  };
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** 视为「从头播放」的最大时间（秒），在此范围内自动跳过片头 */
const AUTO_INTRO_MAX_START_SECONDS = 3;
/** 与浏览器原生控件接近的自动隐藏延迟 */
const CONTROLS_HIDE_DELAY_MS = 2500;

export interface PlayHistoryMeta {
  id: string;
  thumbnail: string;
  source?: string;
  sourceName?: string;
  year?: string;
}

interface Props {
  files: PlayableFile[];
  poster?: string;
  title: string;
  sourceLabel?: string;
  historyMeta?: PlayHistoryMeta;
}

function lineKey(f: PlayableFile): string {
  const i = f.name.indexOf(' · ');
  return i === -1 ? '播放' : f.name.slice(0, i);
}

function episodeLabel(f: PlayableFile): string {
  const i = f.name.indexOf(' · ');
  return i === -1 ? f.name : f.name.slice(i + 3);
}

export default function VideoPlayer({ files, poster, title, sourceLabel, historyMeta }: Props) {
  const [activeLine, setActiveLine] = useState('');
  const [current, setCurrent] = useState<PlayableFile | null>(null);
  const [error, setError] = useState(false);
  const [continuousPlay, setContinuousPlay] = useState(true);
  const [epPage, setEpPage] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerSettings, setPlayerSettings] = useState(getPlayerSettings);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const restoredUrlRef = useRef<string | null>(null);
  const lastHistorySaveRef = useRef(0);
  const hideControlsTimerRef = useRef<number | null>(null);
  const outroSkippedRef = useRef(false);
  const [introSkipped, setIntroSkipped] = useState(false);

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

    const playUrl = proxyStreamUrl(current.url);

    if (isM3u8 && Hls.isSupported()) {
      const hls = new Hls(HLS_PLAYER_CONFIG);
      hlsRef.current = hls;
      hls.loadSource(playUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(true);
      });
    } else if (isM3u8 && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playUrl;
    } else {
      video.src = playUrl;
    }

    void video.play().catch(() => {});

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [current]);

  useEffect(() => {
    restoredUrlRef.current = null;
    setIntroSkipped(false);
    setPlaybackTime(0);
    setDuration(0);
    setIsPlaying(false);
    outroSkippedRef.current = false;
  }, [current?.url]);

  const applySeek = useCallback((target: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(target)) return;
    const clamped = Number.isFinite(video.duration)
      ? Math.max(0, Math.min(video.duration - 0.1, target))
      : Math.max(0, target);
    video.currentTime = clamped;
    setPlaybackTime(clamped);
  }, []);

  const persistHistory = useCallback(
    (force = false) => {
      if (!historyMeta || !current || error) return;
      const video = videoRef.current;
      if (!video) return;
      const now = Date.now();
      if (!force && now - lastHistorySaveRef.current < 4000) return;
      lastHistorySaveRef.current = now;
      upsertPlayHistory({
        id: historyMeta.id,
        title,
        thumbnail: historyMeta.thumbnail,
        source: historyMeta.source,
        sourceName: historyMeta.sourceName ?? sourceLabel,
        year: historyMeta.year,
        episodeLabel: episodeLabel(current),
        playUrl: current.url,
        position: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
      });
    },
    [historyMeta, current, error, title, sourceLabel],
  );

  function restoreHistoryPosition() {
    if (!historyMeta || !current || restoredUrlRef.current === current.url) return;
    restoredUrlRef.current = current.url;
    const hit = getHistoryEntry(historyMeta.id);
    if (!hit || hit.playUrl !== current.url || hit.position == null || hit.position < 3) return;
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration;
    if (Number.isFinite(dur) && hit.position >= dur - 5) return;
    video.currentTime = hit.position;
    if (hit.position >= playerSettings.introSkipSeconds) setIntroSkipped(true);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const video = videoRef.current;
      if (!video || error) return;

      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
      let next = video.currentTime + delta;
      if (Number.isFinite(video.duration)) {
        next = Math.max(0, Math.min(video.duration, next));
      } else {
        next = Math.max(0, next);
      }
      video.currentTime = next;
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [error]);

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

  const scheduleHideControls = useCallback(() => {
    if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = window.setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused) setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY_MS);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  useEffect(() => {
    if (!isPlaying) {
      setControlsVisible(true);
      if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
      return;
    }
    scheduleHideControls();
  }, [isPlaying, scheduleHideControls]);

  useEffect(
    () => () => {
      if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    function onFullscreenChange() {
      const container = playerContainerRef.current;
      setIsFullscreen(Boolean(container && getFullscreenElement() === container));
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = playerContainerRef.current;
    if (!container) return;
    revealControls();
    const active = getFullscreenElement();
    if (active === container) {
      if (document.exitFullscreen) void document.exitFullscreen();
      else {
        const doc = document as Document & { webkitExitFullscreen?: () => void };
        doc.webkitExitFullscreen?.();
      }
      return;
    }
    if (container.requestFullscreen) void container.requestFullscreen();
    else {
      const el = container as HTMLDivElement & { webkitRequestFullscreen?: () => void };
      el.webkitRequestFullscreen?.();
    }
  }, [revealControls]);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video || error) return;
    revealControls();
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, [error, revealControls]);

  const skipIntro = useCallback(() => {
    if (playerSettings.introSkipSeconds <= 0) return;
    applySeek(playerSettings.introSkipSeconds);
    setIntroSkipped(true);
  }, [playerSettings.introSkipSeconds, applySeek]);

  const skipOutro = useCallback(() => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    outroSkippedRef.current = true;
    applySeek(video.duration - 0.5);
  }, [applySeek]);

  const tryAutoSkipIntro = useCallback(() => {
    const video = videoRef.current;
    if (!video || introSkipped || playerSettings.introSkipSeconds <= 0) return;
    if (video.currentTime >= AUTO_INTRO_MAX_START_SECONDS) return;
    applySeek(playerSettings.introSkipSeconds);
    setIntroSkipped(true);
  }, [introSkipped, playerSettings.introSkipSeconds, applySeek]);

  const tryAutoSkipOutro = useCallback(
    (currentTime: number, totalDuration: number) => {
      if (outroSkippedRef.current || playerSettings.outroSkipSeconds <= 0) return;
      if (!Number.isFinite(totalDuration) || totalDuration <= playerSettings.outroSkipSeconds) return;
      if (currentTime <= playerSettings.introSkipSeconds) return;
      if (totalDuration - currentTime > playerSettings.outroSkipSeconds) {
        outroSkippedRef.current = false;
        return;
      }
      outroSkippedRef.current = true;
      applySeek(totalDuration - 0.5);
    },
    [playerSettings.introSkipSeconds, playerSettings.outroSkipSeconds, applySeek],
  );

  const showSkipIntro =
    !introSkipped &&
    playerSettings.introSkipSeconds > 0 &&
    playbackTime < playerSettings.introSkipSeconds;

  const showSkipOutro =
    playerSettings.outroSkipSeconds > 0 &&
    Number.isFinite(duration) &&
    duration > playerSettings.outroSkipSeconds &&
    duration - playbackTime <= playerSettings.outroSkipSeconds &&
    playbackTime > playerSettings.introSkipSeconds;

  function updateIntroSkipSetting(raw: string) {
    const value = Number.parseInt(raw, 10);
    setPlayerSettings(savePlayerSettings({ introSkipSeconds: Number.isNaN(value) ? 0 : value }));
  }

  function updateOutroSkipSetting(raw: string) {
    const value = Number.parseInt(raw, 10);
    setPlayerSettings(savePlayerSettings({ outroSkipSeconds: Number.isNaN(value) ? 0 : value }));
  }

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
            <div
              ref={playerContainerRef}
              className="player-video-inner"
              onMouseMove={revealControls}
              onMouseLeave={() => {
                if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
                if (isPlaying) setControlsVisible(false);
              }}
            >
              <video
                ref={videoRef}
                controls
                controlsList="nofullscreen"
                autoPlay
                playsInline
                poster={poster}
                preload="metadata"
                onMouseMove={revealControls}
                onError={() => setError(true)}
                onEnded={onVideoEnded}
                onLoadedMetadata={(e) => {
                  restoreHistoryPosition();
                  const v = e.currentTarget;
                  setDuration(Number.isFinite(v.duration) ? v.duration : 0);
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => {
                  setIsPlaying(false);
                  persistHistory(true);
                }}
                onPlaying={() => {
                  setIsPlaying(true);
                  tryAutoSkipIntro();
                  persistHistory(true);
                }}
                onTimeUpdate={(e) => {
                  const v = e.currentTarget;
                  const t = v.currentTime;
                  const dur = Number.isFinite(v.duration) ? v.duration : duration;
                  setPlaybackTime(t);
                  if (Number.isFinite(v.duration)) setDuration(v.duration);
                  if (Number.isFinite(dur) && dur > 0) tryAutoSkipOutro(t, dur);
                  persistHistory(false);
                }}
              >
                您的浏览器不支持 HTML5 视频播放。
              </video>

              <div className="player-overlay-controls">
                {showSkipIntro && (
                  <button type="button" className="player-skip-btn" onClick={skipIntro}>
                    跳过片头
                  </button>
                )}
                {showSkipOutro && (
                  <button type="button" className="player-skip-btn" onClick={skipOutro}>
                    跳过片尾
                  </button>
                )}

                {current && (
                  <div className="player-ep-badge">
                    {lineFiles.length > 1
                      ? `${episodeLabel(current)}（${currentIndex + 1}/${lineFiles.length}）`
                      : episodeLabel(current)}
                  </div>
                )}

                <div
                  className={`player-center-bar${controlsVisible ? ' visible' : ''}`}
                  onClick={(e) => e.stopPropagation()}
                  onMouseMove={(e) => {
                    e.stopPropagation();
                    revealControls();
                  }}
                >
                  <button
                    type="button"
                    className="player-icon-btn"
                    disabled={currentIndex <= 0}
                    onClick={playPrevEpisode}
                    title="上一集"
                    aria-label="上一集"
                  >
                    <IconPrev />
                  </button>
                  <button
                    type="button"
                    className="player-icon-btn player-icon-btn-main"
                    onClick={togglePlayPause}
                    title={isPlaying ? '暂停' : '播放'}
                    aria-label={isPlaying ? '暂停' : '播放'}
                  >
                    {isPlaying ? <IconPause /> : <IconPlay />}
                  </button>
                  <button
                    type="button"
                    className="player-icon-btn"
                    disabled={currentIndex < 0 || currentIndex >= lineFiles.length - 1}
                    onClick={playNextEpisode}
                    title="下一集"
                    aria-label="下一集"
                  >
                    <IconNext />
                  </button>
                  <button
                    type="button"
                    className="player-icon-btn player-icon-btn-fs"
                    onClick={toggleFullscreen}
                    title={isFullscreen ? '退出全屏' : '全屏'}
                    aria-label={isFullscreen ? '退出全屏' : '全屏'}
                  >
                    {isFullscreen ? <IconFullscreenExit /> : <IconFullscreenEnter />}
                  </button>
                </div>
              </div>
            </div>
          )
        )}
      </div>

      <div className="player-options">
        <label className="skip-setting">
          <span>片头跳过</span>
          <input
            type="number"
            min={0}
            max={600}
            step={1}
            value={playerSettings.introSkipSeconds}
            onChange={(e) => updateIntroSkipSetting(e.target.value)}
          />
          <span className="skip-unit">秒</span>
        </label>
        <label className="skip-setting">
          <span>片尾跳过</span>
          <input
            type="number"
            min={0}
            max={600}
            step={1}
            value={playerSettings.outroSkipSeconds}
            onChange={(e) => updateOutroSkipSetting(e.target.value)}
          />
          <span className="skip-unit">秒</span>
        </label>
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
