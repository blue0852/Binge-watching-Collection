/** 带 TTL 与容量上限的内存缓存，避免长时间切换站点后内存持续增长 */

interface CacheEntry {
  value: unknown;
  expireAt: number;
  touchedAt: number;
}

const DEFAULT_MAX_ENTRIES = 500;

export function createMemoryCache(maxEntries = DEFAULT_MAX_ENTRIES) {
  const store = new Map<string, CacheEntry>();

  function prune(now = Date.now()) {
    for (const [key, entry] of store) {
      if (entry.expireAt <= now) store.delete(key);
    }
    if (store.size <= maxEntries) return;
    const victims = [...store.entries()]
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
      .slice(0, store.size - maxEntries);
    for (const [key] of victims) store.delete(key);
  }

  async function cached<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expireAt > now) {
      hit.touchedAt = now;
      return hit.value as T;
    }
    const value = await factory();
    store.set(key, { value, expireAt: now + ttlMs, touchedAt: now });
    prune(now);
    return value;
  }

  function clear() {
    const count = store.size;
    store.clear();
    return count;
  }

  return { cached, clear, size: () => store.size };
}

export const apiCache = createMemoryCache();
