# Public Domain Cinema 优化评估报告

> 评估日期：2026-10-21 ｜ 版本：1.0.3 ｜ 方式：源码通读 + 本地实跑接口压测（127.0.0.1:3999）

## 一、结论

项目架构清晰（前后端同仓、Electron 内嵌 Node 服务、构建/打包脚本完备），代码风格统一、注释到位，可以正常构建运行。
但存在 **4 个会直接影响可用性的缺陷** 和 **一批可观的性能余量**，其中最有价值的一条：

> **全站搜索固定耗时 65.7 秒**，且第二次请求（理论上命中缓存）仍是 65.6 秒 —— 这不是网络慢，是代码里的超时配置整体失效 + 失败结果从不缓存。

修掉 P0 的前 3 条，全站搜索可从 **65.7s 降到 2s 上下**（约 30 倍），且不再随资源站数量劣化。

## 二、实测基线

启动后端（`backend/dist/server.js`，端口 3999），串行请求实测：

| 接口 | 首次 | 二次 | 说明 |
|---|---:|---:|---|
| `GET /api/movies?source=dyttzy` | 1506 ms | **3 ms** | 内存缓存生效，符合预期 |
| `GET /api/movies/categories?source=dyttzy` | 236 ms | — | 正常 |
| `GET /api/movies/dyttzy:1` | 458 ms | — | 正常 |
| `GET /api/movies?source=archive` | **65233 ms → 502** | — | 超时链路问题 |
| `GET /api/movies/search/global?q=测试` | **65670 ms** | **65645 ms** | 缓存完全没起作用 |
| `GET /api/movies/sources/latency` | **21039 ms** | — | 一次探测 49 个站 |
| `GET /api/movies/sources` | 8 ms | — | 返回 50 个源（含 archive） |

构建产物：

| 产物 | 体积 |
|---|---|
| `frontend/dist/assets/index-*.js` | 782 KB（gzip 248 KB），**单 chunk，无拆分** |
| `frontend/dist/assets/index-*.css` | 19 KB（gzip 4 KB） |
| `pack/app/backend/dist/server.bundle.mjs` | 1509 KB |
| `.git` 目录 | **290 MB**（历史中有 4 个 ~74 MB 的 exe blob） |

## 三、P0：先修这些（影响可用性 / 会卡死）

### P0-1 `timeout` 选项全部无效，请求实际没有超时

**位置**：`backend/src/services/archiveApi.ts:24`、`upstreamFetch.ts:113`、`upstreamFetch.ts:134`、`sourceLatency.ts:49`

```ts
return await fetch(url, {
  timeout: ARCHIVE_TIMEOUT_MS,   // ← node-fetch v3 不认识这个字段
  headers: { ... },
} as never);                      // ← as never 把类型错误也一起吞掉了
```

**证据**：项目使用 `node-fetch@3.3.2`。该版本已移除 `timeout` 选项，只支持 `signal`（`node_modules/node-fetch/src` 中检索 `timeout` 无任何实现）。传进去的 `timeout` 被静默忽略，`as never` 又把 TS 的类型报错掩盖了。

**后果**：
- 实际超时退化到操作系统 TCP 超时（约 20–65 s），`archiveFetch` 还会重试 3 次 → 单次请求最坏 65 s 以上（实测 65.2 s）。
- 上游「连上了但不发数据」时没有上限，`/api/stream` 可以永久挂住一个 socket。
- `pipeUpstreamToResponse` 完全没有超时控制。

**修复**：

```ts
// backend/src/services/http.ts（新增）
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
```

```ts
// archiveApi.ts
const res = await fetch(url, {
  headers: { 'User-Agent': 'PublicDomainCinema/1.0 (archive proxy)' },
  signal: timeoutSignal(ARCHIVE_TIMEOUT_MS),
});
```

其余 3 处同样把 `timeout: x` 换成 `signal: timeoutSignal(x)`，并删掉 `as never`（之后 TS 会帮你守住这个约定）。
`pipeUpstreamToResponse` 建议加 `signal: timeoutSignal(30_000)`，并且只在「首字节超时」时中断，不要中断整段播放（可用 `AbortSignal.timeout` + 收到首个 chunk 后 `clearTimeout` 的手写实现）。

---

### P0-2 全站搜索被 archive.org 拖死 65 秒

**位置**：`backend/src/routes/movies.ts:195-198`、`vodApi.ts:361-378`

```ts
const [vodResult, archiveResult] = await Promise.all([
  searchAllVodMovies(q, page, 6, rows),
  searchByKeyword(q, page, Math.min(rows, 8)).catch(() => null),  // ← 只是吞错，不会缩短等待
]);
```

`.catch(() => null)` 只处理异常，**不取消请求**。国内网络下 archive.org 不可达，这一路要跑满 65 s，`Promise.all` 于是一直等它；VOD 侧哪怕 300 ms 就返回了，用户也看不到。

**修复要点**（三条一起做才有效）：

1. 给 `searchByKeyword` 透传 `AbortSignal`，全局搜索用 2–3 s 的预算：
```ts
const archiveDeadline = AbortSignal.timeout(2500);
const archiveResult = await searchByKeyword(q, page, Math.min(rows, 8), archiveDeadline)
  .catch(() => null);
```
2. VOD 侧把「分批串行」改成「全部并发 + 并发上限」：
```ts
// 现在：4 批 × 等待每批最慢的一个 = 至少 4 × 单站超时
for (let i = 0; i < sources.length; i += GLOBAL_SEARCH_BATCH) { ... await Promise.allSettled(...) }

// 建议：一次并发，用信号量限制 12 路
const settled = await runPool(sources, 12, ({ key }) =>
  searchVodMovies(key, safe, page, rowsPerSite),
);
```
3. 先把 VOD 结果回给前端也可以（流式/两段式），archive 结果后到再补。对桌面端体验提升最明显。

---

### P0-3 失败结果永不缓存，每次搜索都重新踩一遍坑

**位置**：`backend/src/services/memoryCache.ts:25-36`

```ts
const value = await factory();          // ← 失败直接抛出
store.set(key, { value, ... });         // ← 只有成功才写入
```

`searchVodMovies` 的失败站点、archive 的超时，全都不进缓存。所以「第二次搜索仍 65.6 s」—— 每次都要把 10 多个死站重新超时一遍。

顺带这里也**没有请求合并**：同一个 key 并发 5 次，会打 5 次上游（前端 `client.ts` 的 `cachedGet` 做了 promise 级去重，后端反而没有）。

**修复**（一次把「失败缓存 + 并发合并」都补上）：

```ts
const pending = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttlMs: number, factory: () => Promise<T>, errorTtlMs = 20_000) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expireAt > now) {
    hit.touchedAt = now;
    if (hit.error) throw hit.error;
    return hit.value as T;
  }
  const inflight = pending.get(key);
  if (inflight) return inflight as Promise<T>;

  const task = factory()
    .then((value) => {
      store.set(key, { value, expireAt: Date.now() + ttlMs, touchedAt: Date.now() });
      return value;
    })
    .catch((error: Error) => {
      store.set(key, { error, expireAt: Date.now() + errorTtlMs, touchedAt: Date.now() });
      throw error;
    })
    .finally(() => {
      pending.delete(key);
      prune();
    });

  pending.set(key, task);
  return task;
}
```

配合 P0-2，全站搜索第二页/重复搜索可直接从 65 s 掉到亚秒级。

---

### P0-4 Electron 打包版会「越用越卡，最后整个后端挂住」

**位置**：`desktop/main.mjs:104-154`、`backend/src/server.ts:30-33`

```js
serverProcess = fork(serverEntry, [], { stdio: 'pipe', ... });
...
const onStdout = (buf) => { ... };
serverProcess.stdout?.on('data', onStdout);
// 匹配到端口后：
serverProcess.stdout?.off('data', onStdout);   // ← 从此 stdout 再没有消费者
```

后端每处理一个请求就 `console.log` 一行。检测到端口后监听器被移除，管道里没人读；一旦父进程侧管道缓冲区（约 64 KB）写满，**子进程的 `console.log` 会阻塞，整个 Express 事件循环随之停住**。播一部 HLS 电影会产生上千个分片请求 ≈ 上千行日志，很容易触发。

**修复**（保留监听、只解析一次；同时把请求日志改成可开关）：

```js
let portResolved = false;
serverProcess.stdout?.on('data', (buf) => {
  if (portResolved) return;              // 继续消费，只是不再解析
  const m = buf.toString().match(/localhost:(\d+)/);
  if (!m) return;
  portResolved = true;
  serverPort = Number(m[1]);
  waitForHealth(serverPort).then(succeed).catch(fail);
});
```

```ts
// server.ts
if (process.env.LOG_REQUESTS === '1') {
  app.use((req, _res, next) => { console.log(...); next(); });
}
```

另外 `serverProcess.stderr` 的监听器把内容累加进一个永不清理的字符串（`stderr += ...`），长跑会缓慢吃内存，建议只保留最后 8 KB。

---

### P0-5 服务监听在所有网卡，且代理接口无来源限制

**位置**：`backend/src/server.ts:59`

```ts
const server = app.listen(listenPort, () => { ... });
```

省略 host 时 Node 会绑定 `::` / `0.0.0.0`，即整个局域网都能访问。而 `/api/stream?url=`、`/api/img?url=` 是**任意 URL 代理**，`POST /api/movies/sites` 还能直接改写 `config.json`（无鉴权）。桌面应用完全不需要这个暴露面。

**修复**：

```ts
server = app.listen({ port: listenPort, host: '127.0.0.1' }, () => { ... });
```

同时给两个代理接口加一层内网地址拦截（域名放行、IP 段拒绝），避免被当成打内网的跳板：

```ts
import { isIP } from 'node:net';

function isBlockedHost(hostname: string): boolean {
  if (/(^|\.)localhost$/i.test(hostname) || /\.local$/i.test(hostname)) return true;
  if (!isIP(hostname)) return false;                 // 域名放行（播放源都是域名）
  if (isIP(hostname) === 4) {
    return /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  }
  return /^(::1|fe80:|fc|fd)/i.test(hostname);
}
```

## 四、P1：性能与体验（收益大、风险低）

### P1-1 资源站 49 个里有 10 组重复，搜索成本翻倍

`config.json` 按 API 主机去重后：

| 重复主机 | 重复的 key |
|---|---|
| `caiji.dyttzyapi.com` | `dyttzy`, `dyttzyapi` |
| `bfzyapi.com` | `bfzy`, `bfzyapi` |
| `360zy.com` | `zy360`, `360zy` |
| `jszyapi.com` | `jisu`, `jszyapi` |
| `www.mdzyapi.com` | `mdzy`, `mdzyapi` |
| `api.zuidapi.com` | `zuid`, `zuidapi` |
| `m3u8.apiyhzy.com` | `yinghua`, `apiyhzy` |
| `api.wujinapi.me` | `wujin`, `wujinapi_me` |
| `cj.lziapi.com` | `lzi`, `lziapi` |
| `api.apibdzy.com` | `bdzy`, `apibdzy` |
| `api.xinlangapi.com` | `xinlangapi`, `xinlangapi_provide` |
| `jyzyapi.com` | `jyzyapi`, `jyzyapi_provide` |

同一份数据被采集两遍，结果里还会出现两个同名卡片。删掉重复 key（49 → ~37）可直接减少 1/4 的上游请求。
另外 `yparse` 指向 `https://api.yparse.com/api/json`，不是 MacCMS 协议；`danaizi` 名字还叫 `test` —— 建议一并清掉。

### P1-2 启动就把 49 个站探测一遍（21 秒 + 49 次外连）

`Header.tsx:36-53` 在挂载时调用 `/api/movies/sources/latency`。用户只是打开首页，就产生 49 个出站请求，占 21 s 后台任务，而且 `sourceLatency.ts` 的模块级缓存**没有并发合并**（三个组件同时调 = 探测三遍）。

建议：
- 延迟到「资源站下拉框首次展开」时再探测；
- 结果持久化到 `config.json` 旁的 `latency.json`，启动直接读旧值；
- API 侧加 `if (inflight) return inflight`。

### P1-3 首屏 JS 782 KB，hls.js 被打进主包

`App.tsx` 静态 import `MovieDetail → VideoPlayer → hls.js`，首页根本用不到播放器。Vite 没有 `manualChunks`，也没有任何 `lazy()`。

```tsx
const MovieDetail = lazy(() => import('./pages/MovieDetail.js'));
const Sites = lazy(() => import('./pages/Sites.js'));
const History = lazy(() => import('./pages/History.js'));
```

```ts
// vite.config.ts
build: {
  outDir: 'dist',
  sourcemap: false,
  rollupOptions: { output: { manualChunks: { hls: ['hls.js'] } } },
}
```

预期首屏包从 782 KB 降到 ~250 KB（hls 单独 chunk 按需加载）。桌面端是本地磁盘，收益主要在解析时间和首屏可交互时间。

### P1-4 静态资源没有强缓存策略

`server.ts:43` 的 `express.static(frontendDist)` 用默认 maxAge=0。文件名本身带 hash，可以放心 immutable：

```ts
app.use('/assets', express.static(path.join(frontendDist, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(frontendDist, { maxAge: '1h' }));
```

也可以顺手加 `compression()`（本地回环收益有限，但 `pack` 版通过局域网访问时有用）。

### P1-5 图片代理无大小上限、无并发限制

`routes/images.ts:37` 把整张图 `fetchUpstreamBuffer` 进内存，`winFetchBuffer` 的 `maxBuffer` 还是 50 MB。20 张封面同时失败重试时，内存尖峰明显。
建议：`Content-Length > 8 MB` 直接 413、按 URL 做 10 分钟内存缓存（封面 URL 基本不变）、并发上限 6。

## 五、P2：代码质量与工程化

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| 1 | `onTimeUpdate` 每 250 ms `setPlaybackTime`，整棵选集列表跟着重渲染 | `VideoPlayer.tsx:576-584` | 只在整秒变化时 setState：`if (Math.floor(t) !== lastSecRef.current) { lastSecRef.current = Math.floor(t); setPlaybackTime(t); }` |
| 2 | `Partial<Hls['config']>` 类型不正确 | `VideoPlayer.tsx:13` | 改成 `import type { HlsConfig } from 'hls.js'` → `Partial<HlsConfig>` |
| 3 | 默认「片头跳过 90 秒」且播放即自动 seek | `utils/playerSettings.ts:11` + `tryAutoSkipIntro` | 电影从 0 秒开始播会被直接跳过 90 秒。建议默认 0，或只在用户点「跳过片头」时生效 |
| 4 | `Home.tsx` 三个分支几乎重复，且切换失败时旧列表不清理 | `Home.tsx:65-119` | 抽 `loadList()`；`catch` 里 `setItems([])`；用 `AbortController` 替代 `cancelled` 标志 |
| 5 | 无 404 路由、无 ErrorBoundary | `App.tsx` | 加 `<Route path="*">` 与一个顶层错误边界 |
| 6 | `const DEFAULT_PORT = resolvePort();` 未被使用 | `server.ts:24` | 删除（开了 `noUnusedLocals` 会自动发现） |
| 7 | 无 lint / format / test 脚本 | `package.json` | 加 `"typecheck": "tsc -b"`、`eslint + prettier`；至少给 `vodApi.parsePlayUrls` 补几张单测（`$` / `#` / `$$$` 三种分隔符是易碎点） |
| 8 | `config.json` 写入非原子（直接 `writeFileSync`） | `config.ts:45` | 先写 `config.json.tmp` 再 `renameSync`，避免断电/杀进程后配置损坏 |
| 9 | `config.json` 读入无 schema 校验 | `config.ts:22` | `JSON.parse` 失败会让首个请求 500，建议 try/catch 回退到内置默认配置 |
| 10 | 两套后端构建路径（`tsc → dist/server.js` 与 esbuild bundle） | `backend/package.json` / `prepare-pack.mjs` | 保留可以，但建议 package.json 加注释说明，避免有人只跑了 `tsc` 就以为打包已更新 |
| 11 | README 写「约 56 个站点」，实际 49 | `README.md:7` | 同步为「约 40 个（去重后）」 |
| 12 | 根目录残留 `tmp-*.json`、`tmp-play.html`、`test-proxy.m3u8` | 根目录 | 已被 `.gitignore` 忽略，可手动清理 |

## 六、仓库卫生：`.git` 290 MB

历史提交 `34b2c54`、`be24d94` 里提交过 2 个版本的 portable/setup exe，后续 `01a26b1` 才停止跟踪，但 blob 仍在历史中：

```
8f483a30  74 MB  release/Public Domain Cinema-1.0.0-portable.exe
aede4213  74 MB  release/Public Domain Cinema-1.0.0-setup.exe
5bdafff6  74 MB  release/Public Domain Cinema-1.0.0-portable.exe
75b7af7f  74 MB  release/Public Domain Cinema-1.0.0-setup.exe
```

`git gc` 无法删除（仍被提交引用）。需要重写历史：

```bash
git filter-repo --path release --invert-paths       # 或 BFG --delete-folders release
git push --force --all
```

注意：这会让已有克隆失效，属于破坏性操作，建议在确认没有其他协作者后再执行。

## 七、建议的落地顺序与预期

| 阶段 | 内容 | 预期效果 | 改动量 |
|---|---|---|---|
| 第 1 步 | P0-1 `signal` 超时 + P0-3 失败缓存/并发合并 | 死站不再拖满 60 s；重复搜索秒开 | ~60 行 |
| 第 2 步 | P0-2 全站搜索并发化 + archive 2.5 s 预算 | 全站搜索 **65.7 s → ~2 s** | ~40 行 |
| 第 3 步 | P0-4 stdout 消费 + P0-5 绑定 127.0.0.1 | 消除打包版卡死；去掉局域网暴露面 | ~20 行 |
| 第 4 步 | P1-1 站点去重、P1-2 延迟探测按需 | 上游请求 −25%，启动负担 ≈ 0 | 配置 + ~30 行 |
| 第 5 步 | P1-3 代码分割、P1-4 静态缓存 | 首屏 JS 782 KB → ~250 KB | ~15 行 |
| 第 6 步 | P2 清单 + Git 历史清理 | 可维护性 / 仓库体积 290 MB → ~1 MB | 持续 |

## 八、说明

- 本文所有耗时数字均来自本机实跑（2026-10-21，端口 3999），受网络环境影响，绝对值会有波动；但「全站搜索两次数值几乎相同」「archive 单请求 ≈ 全站搜索耗时」这两点足以定位到代码而非网络。
- 未执行：完整 `npm run build`、Electron 打包、真实播放链路验证。P0-4 的阻塞结论来自 Node 管道背压机制 + 代码路径推导，未做「写满 64 KB 观察挂起」的实测。
- 未修改任何源码，仅新增本报告。
