export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

/** auto=安装版可后台更新；manual=便携版只能跳下载页；dev=非打包环境 */
export type UpdateMode = 'auto' | 'manual' | 'dev';

export interface UpdateState {
  mode: UpdateMode;
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  notes: string;
  message: string;
  releaseUrl: string;
}

export interface UpdaterBridge {
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<boolean>;
  openReleases(): Promise<void>;
  onState(cb: (next: UpdateState) => void): () => void;
}

const DISMISS_KEY = 'pdc.update.dismissed';

/** 页脚"检查更新"按钮与提示条解耦：按钮只发事件，逻辑集中在 UpdateBanner 里 */
export const UPDATE_CHECK_EVENT = 'pdc:update-check';

export function requestUpdateCheck(): void {
  window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
}

export function getUpdaterBridge(): UpdaterBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { updaterBridge?: UpdaterBridge }).updaterBridge;
  return bridge && typeof bridge.getState === 'function' ? bridge : null;
}

export function readDismissedVersion(): string {
  try {
    return window.localStorage.getItem(DISMISS_KEY) || '';
  } catch {
    return '';
  }
}

export function writeDismissedVersion(version: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, version);
  } catch {
    /* 隐私模式下写不进去，忽略即可 */
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
