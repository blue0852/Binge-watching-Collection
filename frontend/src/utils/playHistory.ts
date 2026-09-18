const STORAGE_KEY = 'pdc-play-history-v1';
const MAX_ITEMS = 80;

export interface PlayHistoryEntry {
  id: string;
  title: string;
  thumbnail: string;
  source?: string;
  sourceName?: string;
  year?: string;
  episodeLabel?: string;
  playUrl?: string;
  /** 秒 */
  position?: number;
  duration?: number;
  updatedAt: number;
}

export const HISTORY_CHANGED = 'pdc-history-changed';

function notifyChanged(): void {
  window.dispatchEvent(new Event(HISTORY_CHANGED));
}

function readAll(): PlayHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PlayHistoryEntry =>
        x != null &&
        typeof x === 'object' &&
        typeof (x as PlayHistoryEntry).id === 'string' &&
        typeof (x as PlayHistoryEntry).title === 'string',
    );
  } catch {
    return [];
  }
}

function writeAll(items: PlayHistoryEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  notifyChanged();
}

export function getPlayHistory(): PlayHistoryEntry[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function upsertPlayHistory(partial: Omit<PlayHistoryEntry, 'updatedAt'> & { updatedAt?: number }): void {
  const now = partial.updatedAt ?? Date.now();
  const all = readAll();
  const prev = all.find((x) => x.id === partial.id);
  const rest = all.filter((x) => x.id !== partial.id);
  const merged: PlayHistoryEntry = {
    id: partial.id,
    title: partial.title,
    thumbnail: partial.thumbnail,
    source: partial.source ?? prev?.source,
    sourceName: partial.sourceName ?? prev?.sourceName,
    year: partial.year ?? prev?.year,
    episodeLabel: partial.episodeLabel ?? prev?.episodeLabel,
    playUrl: partial.playUrl ?? prev?.playUrl,
    position: partial.position ?? prev?.position,
    duration: partial.duration ?? prev?.duration,
    updatedAt: now,
  };
  rest.unshift(merged);
  writeAll(rest.slice(0, MAX_ITEMS));
}

export function removePlayHistory(id: string): void {
  writeAll(readAll().filter((x) => x.id !== id));
}

export function clearPlayHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
  notifyChanged();
}

export function getHistoryEntry(id: string): PlayHistoryEntry | undefined {
  return readAll().find((x) => x.id === id);
}

export function formatHistoryTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export function historyProgressPercent(entry: PlayHistoryEntry): number | null {
  const { position, duration } = entry;
  if (position == null || duration == null || duration <= 0) return null;
  return Math.min(100, Math.round((position / duration) * 100));
}

export function historyDetailPath(entry: PlayHistoryEntry): string {
  const params = new URLSearchParams();
  if (entry.source) params.set('source', entry.source);
  const qs = params.toString();
  return qs ? `/movie/${encodeURIComponent(entry.id)}?${qs}` : `/movie/${encodeURIComponent(entry.id)}`;
}
