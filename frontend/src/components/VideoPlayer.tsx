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
import { getPipBridge, savePipSession } from '../pip/pip.js';
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

function IconVolume() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"
      />
    </svg>
  );
}

function IconVolumeMute() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="M16 9.5l5 5M21 9.5l-5 5"
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

/** 音量 / 倍速偏好，跨影片复用 */
const VOLUME_KEY = 'pdc.player.volume.v1';
const MUTED_KEY = 'pdc.player.muted.v1';
const RATE_KEY = 'pdc.player.rate.v1';
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readStoredBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

function storeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 视为「从头播放」的最大时间（秒），在此范围内自动跳过片头 */
const AUTO_INTRO_MAX_START_SECONDS = 3;
/** 与浏览器原生控件接近的自动隐藏延迟 */
const CONTROLS_HIDE_DELAY_MS = 2500;

/** 全局只允许一个播放器实例接管键盘，避免 StrictMode/热更新重复挂监听导致一次按键快进多次 */
let activeKeyHandler: ((event: KeyboardEvent) => void) | null = null;

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
  /** 小窗模式：只保留画面与紧凑控制条，隐藏选集/线路/设置 */
  compact?: boolean;
  /** 点击「小窗」按钮时由外部接管（收进右下角悬浮窗） */
  onEnterMini?: () => void;
  /** 当前实例运行在系统置顶画中画窗口（Document PiP）里 */
  pipMode?: boolean;
  /** 画中画窗口关闭后通知外部（用于重新挂载主播放器、同步进度） */
  onPipClosed?: () => void;
}

/** 桌面端置顶画中画窗口是否需要重新渲染主播放器时由外部处理 */

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
  pipMode = false,
  onPipClosed,
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
  const [pipTip, setPipTip] = useState<string | null>(null);
  const pipTipTimerRef = useRef<number | null>(null);
  const [pipSupported] = useState(
    () =>
      typeof document !== 'undefined' &&
      (Boolean(getPipBridge()) || Boolean(document.pictureInPictureEnabled)),
  );
  const [buffered, setBuffered] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [volume, setVolume] = useState(() => readStoredNumber(VOLUME_KEY, 1));
  const [muted, setMuted] = useState(() => readStoredBool(MUTED_KEY, false));
  const [rate, setRate] = useState(() => readStoredNumber(RATE_KEY, 1));
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const [volumeHover, setVolumeHover] = useState(false);
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

  // 鼠标停在控制条上时不要自动收起，否则拖到一半就消失
  const miniBarHoverRef = useRef(false);
  const scheduleHideControls = useCallback(() => {
    if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = window.setTimeout(() => {
      if (miniBarHoverRef.current) return;
      const video = videoRef.current;
      if (video && !video.paused) setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY_MS);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  useEffect(() => {
    if (!isPlaying || pipMode) {
      setControlsVisible(true);
      if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
      return;
    }
    scheduleHideControls();
  }, [isPlaying, pipMode, scheduleHideControls]);

  // 画中画期间主窗口必须保持静音暂停：任何来源把页面视频重新拉起来都立刻压回去
  useEffect(() => {
    if (!pipActive || pipMode) return;
    const video = videoRef.current;
    if (!video) return;
    const keepPaused = () => {
      if (!video.paused) video.pause();
    };
    keepPaused();
    video.addEventListener('play', keepPaused);
    video.addEventListener('playing', keepPaused);
    return () => {
      video.removeEventListener('play', keepPaused);
      video.removeEventListener('playing', keepPaused);
    };
  }, [pipActive, pipMode]);

  useEffect(
    () => () => {
      if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
      if (pipTipTimerRef.current) window.clearTimeout(pipTipTimerRef.current);
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

  const showPipTip = useCallback((message: string) => {
    setPipTip(message);
    if (pipTipTimerRef.current) window.clearTimeout(pipTipTimerRef.current);
    pipTipTimerRef.current = window.setTimeout(() => setPipTip(null), 3200);
  }, []);

  /**
   * 桌面端画中画：主进程开一个无边框置顶窗口，窗口里是同一个播放器组件，
   * 所以进度条、上一集/下一集都能保留（原生 video PiP 的控件无法自定义）。
   */
  const openDesktopPip = useCallback(async (): Promise<boolean> => {
    const bridge = getPipBridge();
    if (!bridge || pipMode) return false;
    try {
      // 先落盘当前进度，置顶小窗会按播放历史接上同一集、同一位置
      persistHistory(true);
      savePipSession({ files, poster, title, sourceLabel, historyMeta });
      videoRef.current?.pause();
      await bridge.open();
      // 窗口加载期间可能被自动播放/缓冲回调重新拉起来，这里再压一次
      videoRef.current?.pause();
      setPipActive(true);
      return true;
    } catch {
      showPipTip('无法开启画中画窗口');
      return true;
    }
  }, [
    pipMode,
    files,
    poster,
    title,
    sourceLabel,
    historyMeta,
    persistHistory,
    showPipTip,
  ]);

  const togglePictureInPicture = useCallback(() => {
    revealControls();
    const bridge = getPipBridge();
    if (pipMode || pipActive) {
      if (bridge) void bridge.close();
      return;
    }
    if (bridge) {
      void openDesktopPip();
      return;
    }

    // 浏览器环境：回退到原生画中画（控件由系统提供）
    const video = videoRef.current;
    if (!video) return;
    if (!document.pictureInPictureEnabled) {
      showPipTip('当前环境不支持画中画');
      return;
    }
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {});
      return;
    }
    if (!video.videoWidth) {
      showPipTip('视频还没加载出来，稍后再试');
      return;
    }
    video.requestPictureInPicture().catch((err: unknown) => {
      const name = err instanceof DOMException ? err.name : '';
      showPipTip(
        name === 'NotAllowedError'
          ? '系统不允许：请保持主窗口可见（最小化时无法开画中画）'
          : '无法开启画中画，请稍后重试',
      );
    });
  }, [pipMode, pipActive, openDesktopPip, revealControls, showPipTip]);

  // 置顶小窗关闭后：恢复按钮状态，并让外部重挂主播放器以接上小窗里的最新进度
  useEffect(() => {
    const bridge = getPipBridge();
    if (!bridge || pipMode) return;
    return bridge.onClosed(() => {
      setPipActive(false);
      onPipClosed?.();
    });
  }, [pipMode, onPipClosed]);

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

  const changeVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, Number(next.toFixed(2))));
    setVolume(clamped);
    setMuted(clamped === 0);
    const video = videoRef.current;
    if (video) {
      video.volume = clamped;
      video.muted = clamped === 0;
    }
    revealControls();
  }, [revealControls]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      const video = videoRef.current;
      if (video) video.muted = next;
      return next;
    });
    revealControls();
  }, [revealControls]);

  const changeRate = useCallback((next: number) => {
    setRate(next);
    setRateMenuOpen(false);
    const video = videoRef.current;
    if (video) video.playbackRate = next;
    revealControls();
  }, [revealControls]);

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      const total = Number.isFinite(video.duration) ? video.duration : duration;
      if (!total) return;
      video.currentTime = Math.min(Math.max(0, video.currentTime + delta), Math.max(0, total - 0.3));
      revealControls();
    },
    [duration, revealControls],
  );

  // 音量 / 倍速偏好：应用当前值，并在切集后重新套用（video 元素复用时属性不会丢，但要防止被重置）
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
    video.playbackRate = rate;
  }, [volume, muted, rate, current]);

  useEffect(() => {
    storeValue(VOLUME_KEY, String(volume));
  }, [volume]);
  useEffect(() => {
    storeValue(MUTED_KEY, muted ? '1' : '0');
  }, [muted]);
  useEffect(() => {
    storeValue(RATE_KEY, String(rate));
  }, [rate]);

  // 键盘快捷键：空格/K 播放暂停、←→ 快退快进、↑↓ 音量、M 静音、F 全屏、N/P 切集
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === ' ' || key === 'k') {
        event.preventDefault();
        togglePlayPause();
      } else if (key === 'arrowleft') {
        event.preventDefault();
        seekBy(event.shiftKey ? -30 : -SEEK_STEP_SECONDS);
      } else if (key === 'arrowright') {
        event.preventDefault();
        seekBy(event.shiftKey ? 30 : SEEK_STEP_SECONDS);
      } else if (key === 'arrowup') {
        event.preventDefault();
        changeVolume(volume + 0.05);
      } else if (key === 'arrowdown') {
        event.preventDefault();
        changeVolume(volume - 0.05);
      } else if (key === 'm') {
        toggleMute();
      } else if (key === 'f') {
        toggleFullscreen();
      } else if (key === 'n') {
        if (currentIndex >= 0 && currentIndex < lineFiles.length - 1) playNextEpisode();
      } else if (key === 'p') {
        if (currentIndex > 0) playPrevEpisode();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    if (activeKeyHandler && activeKeyHandler !== onKeyDown) {
      document.removeEventListener('keydown', activeKeyHandler);
    }
    activeKeyHandler = onKeyDown;
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (activeKeyHandler === onKeyDown) activeKeyHandler = null;
    };
  }, [
    togglePlayPause,
    seekBy,
    changeVolume,
    toggleMute,
    toggleFullscreen,
    volume,
    currentIndex,
    lineFiles.length,
    playNextEpisode,
    playPrevEpisode,
  ]);

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
  const bufferedPercent =
    progressMax > 0 && buffered > 0 ? Math.min(100, (buffered / progressMax) * 100) : 0;
  const miniBarStyle = { '--progress': `${progressPercent}%` } as CSSProperties;
  const hasPrevEpisode = currentIndex > 0;
  const hasNextEpisode = currentIndex >= 0 && currentIndex < lineFiles.length - 1;

  return (
    <div className={`${compact ? 'player player-compact' : 'player'}${pipMode ? ' player-pip-mode' : ''}`}>
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
                controls={false}
                autoPlay
                playsInline
                poster={poster}
                preload="auto"
                onClick={() => {
                  if (compact) togglePlayPause();
                  else revealControls();
                }}
                onDoubleClick={() => {
                  if (!compact) toggleFullscreen();
                }}
                onMouseMove={revealControls}
                onError={() => setError(true)}
                onWaiting={() => setBuffering(true)}
                onStalled={() => setBuffering(true)}
                onSeeking={() => setBuffering(true)}
                onSeeked={() => setBuffering(false)}
                onCanPlay={() => setBuffering(false)}
                onEnded={onVideoEnded}
                onLoadedMetadata={(e) => {
                  restoreHistoryPosition();
                  const v = e.currentTarget;
                  setDuration(Number.isFinite(v.duration) ? v.duration : 0);
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => {
                  setIsPlaying(false);
                  setBuffering(false);
                  persistHistory(true);
                }}
                onPlaying={() => {
                  setIsPlaying(true);
                  setBuffering(false);
                  tryAutoSkipIntro();
                  persistHistory(true);
                }}
                onProgress={(e) => {
                  const v = e.currentTarget;
                  if (v.buffered.length > 0) {
                    setBuffered(v.buffered.end(v.buffered.length - 1));
                  }
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
                  className={`player-mini-bar${controlsVisible || pipMode ? ' visible' : ''}`}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    revealControls();
                  }}
                  onMouseMove={(e) => {
                    e.stopPropagation();
                    revealControls();
                  }}
                  onMouseEnter={() => {
                    miniBarHoverRef.current = true;
                    revealControls();
                  }}
                  onMouseLeave={() => {
                    miniBarHoverRef.current = false;
                    if (isPlaying) scheduleHideControls();
                  }}
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
                    {pipSupported && (
                      <button
                        type="button"
                        className={`player-mini-btn${pipActive || pipMode ? ' is-active' : ''}`}
                        onClick={togglePictureInPicture}
                        title={pipActive || pipMode ? '退出画中画' : '画中画（浮在其他窗口之上）'}
                        aria-label={pipActive || pipMode ? '退出画中画' : '画中画'}
                      >
                        <IconPictureInPicture />
                      </button>
                    )}
                    <span className="player-mini-time">
                      {formatClock(progressValue) || '0:00'}
                      {progressMax > 0 ? ` / ${formatClock(progressMax)}` : ''}
                    </span>
                  </div>
                </div>
              )}

              <div className="player-overlay-controls">
                {pipTip && <div className="player-pip-tip">{pipTip}</div>}
                {buffering && !error && (
                  <div className="player-buffering" aria-hidden="true">
                    <span className="player-spinner" />
                  </div>
                )}
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

                {!compact && !isPlaying && !buffering && (
                  <button
                    type="button"
                    className="player-big-play"
                    onClick={togglePlayPause}
                    title="播放"
                    aria-label="播放"
                  >
                    <IconPlay />
                  </button>
                )}

                {!compact && (
                  <div
                    className={`player-controls${controlsVisible || !isPlaying ? ' visible' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={() => {
                      miniBarHoverRef.current = true;
                      revealControls();
                    }}
                    onMouseLeave={() => {
                      miniBarHoverRef.current = false;
                      if (isPlaying) scheduleHideControls();
                    }}
                    onMouseMove={(e) => {
                      e.stopPropagation();
                      revealControls();
                    }}
                  >
                    <div className="pc-progress-row">
                      <input
                        type="range"
                        className="pc-progress"
                        style={
                          {
                            '--progress': `${progressPercent}%`,
                            '--buffered': `${bufferedPercent}%`,
                          } as CSSProperties
                        }
                        min={0}
                        max={progressMax || 0}
                        step={0.5}
                        value={progressValue}
                        disabled={progressMax <= 0}
                        onChange={(e) => applySeek(Number(e.target.value))}
                        title="拖动调整播放进度"
                        aria-label="播放进度"
                      />
                    </div>
                    <div className="pc-row">
                      <button
                        type="button"
                        className="pc-btn pc-btn-main"
                        onClick={togglePlayPause}
                        title={isPlaying ? '暂停（空格）' : '播放（空格）'}
                        aria-label={isPlaying ? '暂停' : '播放'}
                      >
                        {isPlaying ? <IconPause /> : <IconPlay />}
                      </button>
                      <button
                        type="button"
                        className="pc-btn"
                        disabled={!hasPrevEpisode}
                        onClick={playPrevEpisode}
                        title="上一集（P）"
                        aria-label="上一集"
                      >
                        <IconPrev />
                      </button>
                      <button
                        type="button"
                        className="pc-btn"
                        disabled={!hasNextEpisode}
                        onClick={playNextEpisode}
                        title="下一集（N）"
                        aria-label="下一集"
                      >
                        <IconNext />
                      </button>
                      <span className="pc-time">
                        {formatClock(progressValue) || '0:00'}
                        <span className="pc-time-sep">/</span>
                        {progressMax > 0 ? formatClock(progressMax) : '--:--'}
                      </span>

                      <span className="pc-spacer" />

                      <div className="pc-rate">
                        <button
                          type="button"
                          className={`pc-btn pc-rate-btn${rate !== 1 ? ' is-active' : ''}`}
                          onClick={() => setRateMenuOpen((open) => !open)}
                          title="播放速度"
                          aria-label="播放速度"
                        >
                          {rate}x
                        </button>
                        {rateMenuOpen && (
                          <div className="pc-menu">
                            {PLAYBACK_RATES.map((value) => (
                              <button
                                key={value}
                                type="button"
                                className={`pc-menu-item${value === rate ? ' active' : ''}`}
                                onClick={() => changeRate(value)}
                              >
                                {value}x
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <div
                        className="pc-volume"
                        onMouseEnter={() => setVolumeHover(true)}
                        onMouseLeave={() => setVolumeHover(false)}
                      >
                        <button
                          type="button"
                          className="pc-btn"
                          onClick={toggleMute}
                          title={muted ? '取消静音（M）' : '静音（M）'}
                          aria-label={muted ? '取消静音' : '静音'}
                        >
                          {muted || volume === 0 ? <IconVolumeMute /> : <IconVolume />}
                        </button>
                        {volumeHover && (
                          <div className="pc-volume-pop">
                            <input
                              type="range"
                              className="pc-volume-slider"
                              min={0}
                              max={1}
                              step={0.02}
                              value={muted ? 0 : volume}
                              onChange={(e) => changeVolume(Number(e.target.value))}
                              aria-label="音量"
                            />
                          </div>
                        )}
                      </div>

                      {onEnterMini && (
                        <button
                          type="button"
                          className="pc-btn"
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
                          className={`pc-btn${pipActive ? ' is-active' : ''}`}
                          onClick={togglePictureInPicture}
                          title={pipActive ? '退出画中画' : '画中画（浮在其他窗口之上）'}
                          aria-label={pipActive ? '退出画中画' : '画中画'}
                        >
                          <IconPictureInPicture />
                        </button>
                      )}
                      <button
                        type="button"
                        className="pc-btn"
                        onClick={toggleFullscreen}
                        title={isFullscreen ? '退出全屏（Esc）' : '全屏（F）'}
                        aria-label={isFullscreen ? '退出全屏' : '全屏'}
                      >
                        {isFullscreen ? <IconFullscreenExit /> : <IconFullscreenEnter />}
                      </button>
                    </div>
                  </div>
                )}
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
