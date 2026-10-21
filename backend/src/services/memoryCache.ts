/** 带 TTL 与容量上限的内存缓存，避免长时间切换站点后内存持续增长 */

interface CacheEntry {
  value?: unknown;
  /** 失败结果同样缓存，避免每次请求都重新踩一遍失效资源站 */
  error?: Error;
  expireAt: number;
  touchedAt: number;
}

export interface CacheOptions {
  /** 失败结果保留时长；0 表示不缓存失败 */
  errorTtlMs?: number;
}

const DEFAULT_MAX_ENTRIES = 500;
/** 失败（超时 / 连接失败）默认只记 20 秒，够挡住连续重试，又不会长期误伤恢复的站点 */
const DEFAULT_ERROR_TTL_MS = 20_000;

export function createMemoryCache(maxEntries = DEFAULT_MAX_ENTRIES) {
  const store = new Map<string, CacheEntry>();
  /** 同 key 并发请求合并：多个调用方共享同一个上游请求 */
  const pending = new Map<string, Promise<unknown>>();

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

  async function cached<T>(
    key: string,
    ttlMs: number,
    factory: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expireAt > now) {
      hit.touchedAt = now;
      if (hit.error) throw hit.error;
      return hit.value as T;
    }

    const inflight = pending.get(key);
    if (inflight) return inflight as Promise<T>;

    const errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
    const task = factory()
      .then((value) => {
        store.set(key, { value, expireAt: Date.now() + ttlMs, touchedAt: Date.now() });
        return value;
      })
      .catch((error: Error) => {
        if (errorTtlMs > 0) {
          store.set(key, { error, expireAt: Date.now() + errorTtlMs, touchedAt: Date.now() });
        }
        throw error;
      })
      .finally(() => {
        pending.delete(key);
        prune();
      });

    pending.set(key, task);
    return task;
  }

  function clear() {
    const count = store.size;
    store.clear();
    pending.clear();
    return count;
  }

  return { cached, clear, size: () => store.size };
}

export const apiCache = createMemoryCache();
