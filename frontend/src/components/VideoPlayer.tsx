import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { CSSProperties } from 'react';
import Hls from 'hls.js';
import type { HlsConfig } from 'hls.js';
import Pagination from './Pagination.js';
import {
  formatClock,
  getHistoryEntry,
  upsertPlayHistory,
  type PlayHistoryEntry,
} from '../utils/playHistory.js';
import { getPlayerSettings, savePlayerSettings } from '../utils/playerSettings.js';
import { proxyStreamUrl } from '../utils/streamUrl.js';
import type { PlayableFile } from '../types.js';

const EPISODES_PER_PAGE = 20;
const SEEK_STEP_SECONDS = 10;

/** m3u8 / HLS 专用：预取分片、容错与缓冲 */
const HLS_PLAYER_CONFIG: Partial<HlsConfig> = {
  enableWorker: true,
  autoStartLoad: true,
  startFragPrefetch: true,
  testBandwidth: false,
  maxBufferLength: 35,
  maxMaxBufferLength: 150,
  maxBufferSize: 100 * 1000 * 1000,
  maxBufferHole: 0.35,
  backBufferLength: 30,
  maxStarvationDelay: 4,
  maxLoadingDelay: 4,
  nudgeOnVideoHole: true,
  nudgeOffset: 0.1,
  fragLoadingTimeOut: 20_000,
  manifestLoadingTimeOut: 10_000,
  fragLoadingMaxRetry: 8,
  manifestLoadingMaxRetry: 4,
  startLevel: -1,
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

function IconMiniWindow() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6v-2H5V7h14v4h2V7a2 2 0 0 0-2-2z"
      />
      <rect x="12" y="12" width="9" height="7" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function IconPictureInPicture() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5v-2H5V7h14v3h2V7a2 2 0 0 0-2-2z"
      />
      <rect x="12" y="11" width="10" height="8" rx="1.5" fill="currentColor" />
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
  /** 小窗模式：只保留画面与原生控件，隐藏选集/线路/设置 */
  compact?: boolean;
  /** 点击「小窗」按钮时由外部接管（收进右下角悬浮窗） */
  onEnterMini?: () => void;
}

function lineKey(f: PlayableFile): string {
  const i = f.name.indexOf(' · ');
  return i === -1 ? '播放' : f.name.slice(0, i);
}

function episodeLabel(f: PlayableFile): string {
  const i = f.name.indexOf(' · ');
  return i === -1 ? f.name : f.name.slice(i + 3);
}

function fileLooksM3u8(f: PlayableFile): boolean {
  return f.format === 'm3u8' || f.url.includes('.m3u8') || f.mimetype.includes('mpegurl');
}

/** 多数资源为 m3u8 时优先选 HLS 线路 */
function pickDefaultLine(lineGroups: Map<string, PlayableFile[]>, names: string[]): string {
  const hlsLine = names.find((n) => lineGroups.get(n)?.some(fileLooksM3u8));
  return hlsLine ?? names[0] ?? '';
}

export default function VideoPlayer({
  files,
  poster,
  title,
  sourceLabel,
  historyMeta,
  compact = false,
  onEnterMini,
}: Props) {
  // 线路分组先算好，才能把「上次看的线路 + 那一集」直接作为初始状态
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

  // 只在首次挂载时读一次历史：之后由播放本身写回，避免被旧记录反复拉回
  const initialHistoryRef = useRef<PlayHistoryEntry | null | undefined>(undefined);
  if (initialHistoryRef.current === undefined) {
    initialHistoryRef.current = historyMeta ? (getHistoryEntry(historyMeta.id) ?? null) : null;
  }

  /** 由历史记录推导出「上次的线路 + 那一集的位置」 */
  const initialRestore = useMemo(() => {
    const empty = { line: '', index: -1 };
    const hit = initialHistoryRef.current;
    if (!hit) return empty;
    // 以实际文件为准反查线路：老记录只有 playUrl 也能定位
    const owner = hit.playUrl ? files.find((f) => f.url === hit.playUrl) : undefined;
    const line = owner
      ? lineKey(owner)
      : hit.lineName && lineGroups.has(hit.lineName)
        ? hit.lineName
        : '';
    if (!line) return empty;
    const list = lineGroups.get(line) ?? [];
    return { line, index: owner ? list.findIndex((f) => f.url === owner.url) : -1 };
    // 仅在挂载时计算一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initialLine = initialRestore.line || pickDefaultLine(lineGroups, lineNames);
  const [activeLine, setActiveLine] = useState(initialLine);
  const [current, setCurrent] = useState<PlayableFile | null>(() => {
    const list = lineGroups.get(initialLine) ?? [];
    if (initialRestore.index >= 0) return list[initialRestore.index] ?? null;
    return list[0] ?? null;
  });
  const [error, setError] = useState(false);
  const [continuousPlay, setContinuousPlay] = useState(true);
  const [epPage, setEpPage] = useState(() =>
    initialRestore.index >= 0 ? Math.floor(initialRestore.index / EPISODES_PER_PAGE) + 1 : 1,
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerSettings, setPlayerSettings] = useState(getPlayerSettings);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [pipSupported] = useState(
    () => typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled),
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const restoredUrlRef = useRef<string | null>(null);
  const lastHistorySaveRef = useRef(0);
  /** 播放进度快照：video 元素被卸载后仍能落盘 */
  const lastProgressRef = useRef<{ url: string; position: number; duration?: number } | null>(null);
  /** timeupdate 每 250ms 触发一次，只在整秒变化时更新 state，避免整棵选集列表重渲染 */
  const lastPlaybackSecondRef = useRef(-1);
  const lastDurationSecondRef = useRef(-1);
  const hideControlsTimerRef = useRef<number | null>(null);
  const outroSkippedRef = useRef(false);
  const [introSkipped, setIntroSkipped] = useState(false);

  const lineFiles = useMemo(() => {
    const key = activeLine || lineNames[0] || '';
    return lineGroups.get(key) ?? [];
  }, [lineGroups, activeLine, lineNames]);

  useEffect(() => {
    if (lineNames.length === 0) return;
    setActiveLine((prev) =>
      prev && lineGroups.has(prev) ? prev : pickDefaultLine(lineGroups, lineNames),
    );
  }, [lineNames, lineGroups]);

  useEffect(() => {
    if (lineFiles.length === 0) return;
    // 切换线路后 current 可能不在新线路里，此时回到第一集
    const kept = Boolean(current && lineFiles.some((f) => f.url === current.url));
    if (!kept) {
      setCurrent(lineFiles[0]);
      setEpPage(1);
    }
    setError(false);
  }, [lineFiles, current]);

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

    let cancelled = false;
    const tryPlay = () => {
      void video.play().catch(() => {});
    };

    if (isM3u8 && Hls.isSupported()) {
      const hls = new Hls(HLS_PLAYER_CONFIG);
      hlsRef.current = hls;
      hls.attachMedia(video);
      let playStarted = false;
      const tryPlayOnce = () => {
        if (cancelled || playStarted) return;
        playStarted = true;
        tryPlay();
      };
      hls.on(Hls.Events.FRAG_BUFFERED, (_e, data) => {
        if (data.frag.type === 'main') tryPlayOnce();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        window.setTimeout(() => {
          if (!cancelled) tryPlayOnce();
        }, 3000);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            setError(true);
            break;
        }
      });
      hls.loadSource(playUrl);
    } else if (isM3u8 && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playUrl;
      video.addEventListener('canplay', tryPlay, { once: true });
    } else {
      video.src = playUrl;
      video.addEventListener('canplay', tryPlay, { once: true });
    }

    return () => {
      cancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [current]);

  useEffect(() => {
    restoredUrlRef.current = null;
    lastPlaybackSecondRef.current = -1;
    lastDurationSecondRef.current = -1;
    lastHistorySaveRef.current = 0;
    lastProgressRef.current = null;
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
      const snap = lastProgressRef.current;
      // 视频元素已卸载（关小窗/切页）时退回最后一次进度快照
      const useSnap = !video && snap?.url === current.url;
      const position = video ? video.currentTime : useSnap ? snap!.position : null;
      const duration = video
        ? Number.isFinite(video.duration)
          ? video.duration
          : undefined
        : useSnap
          ? snap!.duration
          : undefined;
      if (position == null) return;

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
        lineName: lineKey(current),
        position,
        duration,
      });
    },
    [historyMeta, current, error, title, sourceLabel],
  );

  /** 元数据就绪后把进度定位到上次的位置；只对「上次那一集」生效 */
  function restoreHistoryPosition() {
    const hit = initialHistoryRef.current;
    const video = videoRef.current;
    if (!hit || !current || !video) return;
    if (restoredUrlRef.current === current.url) return;
    if (hit.position == null || hit.position < 3) return;
    // 换线路 / 换集后地址会变，此时不跳转，只记录已经处理过
    if (hit.playUrl && hit.playUrl !== current.url) return;

    const dur = video.duration;
    if (Number.isFinite(dur) && dur > 0 && hit.position >= dur - 5) return;

    restoredUrlRef.current = current.url;
    try {
      video.currentTime = hit.position;
      setPlaybackTime(hit.position);
    } catch {
      /* 部分分片流在元数据前不允许 seek，忽略即可 */
    }
    if (hit.position >= playerSettings.introSkipSeconds) setIntroSkipped(true);
  }

  // 关闭页面 / 切后台 / 播放器卸载时立即落盘，避免最后几秒进度丢失
  const persistRef = useRef(persistHistory);
  persistRef.current = persistHistory;
  useEffect(() => {
    const flush = () => persistRef.current(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, []);

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    video.addEventListener('enterpictureinpicture', onEnter);
    video.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter);
      video.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, [current]);

  const togglePictureInPicture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) return;
    revealControls();
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {});
      return;
    }
    void video.requestPictureInPicture().catch(() => {});
  }, [revealControls]);

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

  // 小窗自建控制条：360px 宽时原生控件太挤、进度条常常不出来，这里单独做一条
  const progressMax = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const progressValue = progressMax > 0 ? Math.min(playbackTime, progressMax) : 0;
  const progressPercent = progressMax > 0 ? (progressValue / progressMax) * 100 : 0;
  const miniBarStyle = { '--progress': `${progressPercent}%` } as CSSProperties;
  const hasPrevEpisode = currentIndex > 0;
  const hasNextEpisode = currentIndex >= 0 && currentIndex < lineFiles.length - 1;

  return (
    <div className={compact ? 'player player-compact' : 'player'}>
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
                controls={!compact}
                controlsList="nofullscreen"
                autoPlay
                playsInline
                poster={poster}
                preload="auto"
                onClick={() => {
                  if (compact) togglePlayPause();
                }}
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
                  lastProgressRef.current = {
                    url: current?.url ?? '',
                    position: t,
                    duration: Number.isFinite(v.duration) ? v.duration : undefined,
                  };
                  const sec = Math.floor(t);
                  if (sec !== lastPlaybackSecondRef.current) {
                    lastPlaybackSecondRef.current = sec;
                    setPlaybackTime(t);
                  }
                  if (
                    Number.isFinite(v.duration) &&
                    Math.floor(v.duration) !== lastDurationSecondRef.current
                  ) {
                    lastDurationSecondRef.current = Math.floor(v.duration);
                    setDuration(v.duration);
                  }
                  if (Number.isFinite(dur) && dur > 0) tryAutoSkipOutro(t, dur);
                  persistHistory(false);
                }}
              >
                您的浏览器不支持 HTML5 视频播放。
              </video>

              {compact && (
                <div
                  className="player-mini-bar"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <input
                    type="range"
                    className="player-mini-progress"
                    style={miniBarStyle}
                    min={0}
                    max={progressMax || 0}
                    step={0.5}
                    value={progressValue}
                    disabled={progressMax <= 0}
                    onChange={(e) => applySeek(Number(e.target.value))}
                    title="拖动调整播放进度"
                    aria-label="播放进度"
                  />
                  <div className="player-mini-row">
                    <button
                      type="button"
                      className="player-mini-btn"
                      disabled={!hasPrevEpisode}
                      onClick={playPrevEpisode}
                      title="上一集"
                      aria-label="上一集"
                    >
                      <IconPrev />
                    </button>
                    <button
                      type="button"
                      className="player-mini-btn player-mini-btn-main"
                      onClick={togglePlayPause}
                      title={isPlaying ? '暂停' : '播放'}
                      aria-label={isPlaying ? '暂停' : '播放'}
                    >
                      {isPlaying ? <IconPause /> : <IconPlay />}
                    </button>
                    <button
                      type="button"
                      className="player-mini-btn"
                      disabled={!hasNextEpisode}
                      onClick={playNextEpisode}
                      title="下一集"
                      aria-label="下一集"
                    >
                      <IconNext />
                    </button>
                    <span className="player-mini-time">
                      {formatClock(progressValue) || '0:00'}
                      {progressMax > 0 ? ` / ${formatClock(progressMax)}` : ''}
                    </span>
                  </div>
                </div>
              )}

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
                  {onEnterMini && (
                    <button
                      type="button"
                      className="player-icon-btn"
                      onClick={onEnterMini}
                      title="小窗播放（切页面也能继续看）"
                      aria-label="小窗播放"
                    >
                      <IconMiniWindow />
                    </button>
                  )}
                  {pipSupported && (
                    <button
                      type="button"
                      className={`player-icon-btn${pipActive ? ' is-active' : ''}`}
                      onClick={togglePictureInPicture}
                      title={pipActive ? '退出画中画' : '画中画（浮在其他窗口之上）'}
                      aria-label={pipActive ? '退出画中画' : '画中画'}
                    >
                      <IconPictureInPicture />
                    </button>
                  )}
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

      {!compact && (
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
      )}

      {!compact && lineNames.length > 1 && (
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

      {!compact && lineFiles.length > 1 && (
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

      {!compact && (
        <p className="player-credit">
          正在播放「{title}」{sourceLabel ? ` · ${sourceLabel}` : ''}
        </p>
      )}
    </div>
  );
}
