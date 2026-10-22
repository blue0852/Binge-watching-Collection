import type { PlayableFile } from '../types.js';
import type { PlayHistoryMeta } from '../components/VideoPlayer.js';

/** 桌面端画中画：主窗口写入会话，置顶小窗读取后自己渲染播放器 */
export const PIP_SESSION_KEY = 'pdc-pip-session';

export interface PipSession {
  files: PlayableFile[];
  poster?: string;
  title: string;
  sourceLabel?: string;
  historyMeta?: PlayHistoryMeta;
}

export function savePipSession(session: PipSession): void {
  try {
    localStorage.setItem(PIP_SESSION_KEY, JSON.stringify(session));
  } catch {
    /* 存储满/隐私模式忽略 */
  }
}

export function readPipSession(): PipSession | null {
  try {
    const raw = localStorage.getItem(PIP_SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PipSession;
    if (!data || !Array.isArray(data.files) || data.files.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export interface PipBridge {
  supported: boolean;
  open: () => Promise<void>;
  close: () => Promise<void>;
  onClosed: (cb: () => void) => () => void;
}

/** Electron 桌面端才有；浏览器环境返回 null，回退到原生 video 画中画 */
export function getPipBridge(): PipBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { pipBridge?: PipBridge }).pipBridge;
  return bridge && typeof bridge.open === 'function' ? bridge : null;
}
