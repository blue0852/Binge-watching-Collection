/** HLS 分片（ts/m4s 等）内存缓存：VOD 分片 URL 不变，重复拉取/seek 可命中 */

interface SegmentEntry {
  body: Buffer;
  contentType: string;
  size: number;
  touchedAt: number;
}

const MAX_ENTRIES = 180;
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

const store = new Map<string, SegmentEntry>();
let totalBytes = 0;

export function isCacheableSegmentUrl(url: string): boolean {
  if (url.includes('.m3u8')) return false;
  return /\.(ts|m4s|aac|mp3|vtt)(\?|$)/i.test(url);
}

export function getCachedSegment(url: string): SegmentEntry | null {
  const hit = store.get(url);
  if (!hit) return null;
  hit.touchedAt = Date.now();
  return hit;
}

export function putCachedSegment(url: string, body: Buffer, contentType: string): void {
  if (body.length === 0 || body.length > MAX_ENTRY_BYTES) return;

  const prev = store.get(url);
  if (prev) totalBytes -= prev.size;

  store.set(url, {
    body,
    contentType,
    size: body.length,
    touchedAt: Date.now(),
  });
  totalBytes += body.length;
  prune();
}

function prune() {
  while (store.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    let oldestKey: string | null = null;
    let oldestTouch = Infinity;
    for (const [key, entry] of store) {
      if (entry.touchedAt < oldestTouch) {
        oldestTouch = entry.touchedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const removed = store.get(oldestKey);
    store.delete(oldestKey);
    if (removed) totalBytes -= removed.size;
  }
}

export function clearSegmentCache(): number {
  const count = store.size;
  store.clear();
  totalBytes = 0;
  return count;
}

/** m3u8 播放列表短缓存（改写后的文本），减少频繁拉 manifest */
const playlistStore = new Map<string, { text: string; expireAt: number }>();
const PLAYLIST_TTL_MS = 45_000;

export function getCachedPlaylist(url: string): string | null {
  const hit = playlistStore.get(url);
  if (!hit || hit.expireAt <= Date.now()) {
    playlistStore.delete(url);
    return null;
  }
  return hit.text;
}

export function putCachedPlaylist(url: string, text: string): void {
  playlistStore.set(url, { text, expireAt: Date.now() + PLAYLIST_TTL_MS });
  if (playlistStore.size > 120) {
    const now = Date.now();
    for (const [key, entry] of playlistStore) {
      if (entry.expireAt <= now) playlistStore.delete(key);
    }
  }
}

export function clearPlaylistCache(): number {
  const count = playlistStore.size;
  playlistStore.clear();
  return count;
}

export function clearMediaCaches(): { segments: number; playlists: number } {
  return { segments: clearSegmentCache(), playlists: clearPlaylistCache() };
}
