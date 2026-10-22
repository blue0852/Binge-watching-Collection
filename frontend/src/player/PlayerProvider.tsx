// 全局播放器：把视频提到应用层，详情页只提供「停靠位」。
// 这样离开详情页时播放不会中断，播放器会自动收进右下角小窗。

import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import type { PlayHistoryMeta } from '../components/VideoPlayer.js';
import type { PlayableFile } from '../types.js';

// 播放器带着 hls.js，按需加载，避免拖慢首屏
const VideoPlayer = lazy(() => import('../components/VideoPlayer.js'));

export interface PlayerSession {
  /** 详情页 id，用于判断「回到同一部影片」而不是重新起播 */
  key: string;
  files: PlayableFile[];
  poster?: string;
  title: string;
  sourceLabel?: string;
  historyMeta?: PlayHistoryMeta;
}

type PlayerMode = 'inline' | 'mini';

interface PlayerContextValue {
  session: PlayerSession | null;
  mode: PlayerMode;
  open: (session: PlayerSession) => void;
  registerSlot: (el: HTMLElement) => void;
  unregisterSlot: (el: HTMLElement) => void;
  restoreInline: () => void;
  enterMini: () => void;
  close: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

/** 小窗宽度；窗口过窄时按视口收缩 */
const MINI_WIDTH = 360;
const MINI_MIN_WIDTH = 240;
const MINI_MARGIN = 20;
/** 详情页卸载后等待一小会儿再收进小窗，避免路由切换时闪一下 */
const AUTO_MINI_DELAY_MS = 350;

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer 必须在 PlayerProvider 内使用');
  return ctx;
}

function miniWidth(): number {
  return Math.max(MINI_MIN_WIDTH, Math.min(MINI_WIDTH, window.innerWidth - MINI_MARGIN * 2));
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [mode, setMode] = useState<PlayerMode>('inline');
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [miniPos, setMiniPos] = useState<{ left: number; top: number } | null>(null);
  // 画中画窗口关闭后递增，强制重挂播放器以接上画中画里的最新进度/集数
  const [pipEpoch, setPipEpoch] = useState(0);
  const floatRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const sessionRef = useRef<PlayerSession | null>(null);
  sessionRef.current = session;
  const closeRef = useRef<() => void>(() => {});

  const open = useCallback((next: PlayerSession) => {
    // 同一部影片再次进入详情页：保留当前播放进度，只重新停靠
    setSession((prev) => (prev && prev.key === next.key ? prev : next));
    setMode('inline');
    setMiniPos(null);
  }, []);

  const registerSlot = useCallback((el: HTMLElement) => {
    setSlotEl(el);
  }, []);

  const unregisterSlot = useCallback((el: HTMLElement) => {
    setSlotEl((prev) => (prev === el ? null : prev));
  }, []);

  const restoreInline = useCallback(() => {
    if (slotEl) {
      setMode('inline');
      return;
    }
    const current = sessionRef.current;
    if (!current) return;
    // 不在详情页时，回到该影片详情页取下停靠位
    navigate(`/movie/${encodeURIComponent(current.key)}`);
  }, [navigate, slotEl]);

  const enterMini = useCallback(() => {
    setMiniPos(null);
    setMode('mini');
  }, []);

  const close = useCallback(() => {
    setSession(null);
    setMode('inline');
    setMiniPos(null);
  }, []);
  closeRef.current = close;

  // 详情页卸载（换了页面）且停靠位消失 → 直接停止播放并收起播放器，
  // 不再自动弹出右下角小窗；小窗只能通过播放器上的「小窗」按钮显式进入。
  // 留 350ms 缓冲：详情页间跳转时停靠位会短暂消失，避免误关。
  useEffect(() => {
    if (!session || mode !== 'inline' || slotEl) return;
    const timer = window.setTimeout(() => {
      closeRef.current();
    }, AUTO_MINI_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [session, mode, slotEl]);

  // 停靠模式：直接改 style，避免滚动时 React 状态更新造成画面滞后
  const lastSlotHeightRef = useRef(0);
  useEffect(() => {
    if (mode !== 'inline' || !slotEl) return;
    const apply = () => {
      const el = floatRef.current;
      if (!el) return;
      const rect = slotEl.getBoundingClientRect();
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.width = `${rect.width}px`;
      // 占位块跟随播放器实际高度（视频 + 选集/线路），否则会遮住下方正文；
      // 高度没变就跳过，避免 ResizeObserver 反复触发
      const height = el.offsetHeight;
      if (height > 0 && Math.abs(height - lastSlotHeightRef.current) > 1) {
        lastSlotHeightRef.current = height;
        slotEl.style.height = `${height}px`;
      }
      el.style.visibility = rect.width > 0 ? 'visible' : 'hidden';
    };
    lastSlotHeightRef.current = 0;
    apply();
    window.addEventListener('scroll', apply, { passive: true });
    window.addEventListener('resize', apply);
    const observer = new ResizeObserver(apply);
    observer.observe(slotEl);
    return () => {
      window.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      observer.disconnect();
      slotEl.style.height = '';
    };
  }, [mode, slotEl, session]);

  // 小窗拖拽
  const onDragStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = floatRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onDragMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = floatRef.current;
    if (!drag || !el) return;
    const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - el.offsetHeight);
    setMiniPos({
      left: Math.min(Math.max(0, e.clientX - drag.dx), maxLeft),
      top: Math.min(Math.max(0, e.clientY - drag.dy), maxTop),
    });
  }, []);

  const onDragEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const value = useMemo<PlayerContextValue>(
    () => ({
      session,
      mode,
      open,
      registerSlot,
      unregisterSlot,
      restoreInline,
      enterMini,
      close,
    }),
    [session, mode, open, registerSlot, unregisterSlot, restoreInline, enterMini, close],
  );

  const floatStyle: CSSProperties =
    mode === 'mini'
      ? miniPos
        ? { left: miniPos.left, top: miniPos.top, width: miniWidth() }
        : { left: 'auto', top: 'auto', right: MINI_MARGIN, bottom: MINI_MARGIN, width: miniWidth() }
      : {};

  return (
    <PlayerContext.Provider value={value}>
      {children}
      {session && (
        <div
          ref={floatRef}
          className={`player-float ${mode === 'mini' ? 'is-mini' : 'is-docked'}`}
          style={floatStyle}
        >
          {mode === 'mini' && (
            <div
              className="player-float-bar"
              onPointerDown={onDragStart}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
            >
              <span className="player-float-title" title={session.title}>
                {session.title}
              </span>
              <button type="button" onClick={restoreInline} title="还原到页面播放">
                还原
              </button>
              <button type="button" onClick={close} title="关闭小窗并停止播放">
                关闭
              </button>
            </div>
          )}
          <Suspense fallback={<div className="player-float-loading" />}>
            <VideoPlayer
              key={`${session.key}:${pipEpoch}`}
              files={session.files}
              poster={session.poster}
              title={session.title}
              sourceLabel={session.sourceLabel}
              historyMeta={session.historyMeta}
              compact={mode === 'mini'}
              onEnterMini={enterMini}
              onPipClosed={() => setPipEpoch((n) => n + 1)}
            />
          </Suspense>
        </div>
      )}
    </PlayerContext.Provider>
  );
}
