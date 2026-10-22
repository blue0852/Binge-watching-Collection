# 优化实施记录（2026-10-21）

> 对应评估报告：`docs/optimization-review-2026-10-21.md`
> 范围：P0 全部 + P1 全部 + P2 全部可执行项；仅 Git 历史重写与 Electron 打包未执行（原因见文末）。

## 一、实测对比（本机 127.0.0.1:3999，冷启动串行请求）

| 接口 | 优化前 | 优化后（首次） | 优化后（再次） |
|---|---:|---:|---:|
| `search/global?q=测试` | **65 670 ms** | **7 038 ms** | **7 ms** |
| `movies?source=archive` | **65 233 ms → 502** | 10 025 ms → 502 | 18 ms（失败缓存） |
| `sources/latency` | **21 039 ms** | 4 394 ms | 3 ms（重启后 106 ms，读落盘结果） |
| `movies?source=dyttzy` | 1 506 ms | 1 086 ms | 4 ms |
| `movies/categories` | 236 ms | 1 092 ms（网络波动） | 缓存命中 |
| `movies/:id` | 458 ms | 238 ms | 缓存命中 |
| `sources` | 8 ms | 8 ms | 36 个源（35 VOD + archive） |

构建产物：

| 产物 | 优化前 | 优化后 |
|---|---|---|
| 首屏 JS | 782 KB 单 chunk | **187 KB**（index 23.4 + react 163.5） |
| hls.js | 打包进主 chunk | **594 KB 独立懒加载 chunk** |
| 首屏 HTML 预加载 | — | 仅 index + react，不含 hls |

全站搜索从 65.7 s → 7 s（约 9.3 倍），重复搜索 7 ms（约 9400 倍）。首屏 JS 减少 76%。

## 二、P0 修复

### 1. 超时全部失效（根因）

`node-fetch@3.3.2` 不认 `timeout`，只认 `signal`；原代码用 `as never` 压掉了类型报错，超时实际退化到 TCP 层。

- 新增 `backend/src/services/http.ts`：`timeoutSignal()` / `mergeSignals()` / `parseProxyUrl()`。
- `upstreamFetch.ts`：3 处 `timeout:` 改为 `signal: timeoutSignal()`，删除全部 `as never`；`AbortError/TimeoutError` 统一转成「上游请求超时」。
- `archiveApi.ts`、`sourceLatency.ts`、`stream.ts` 同步改造。
- `upstreamError.ts`：超时 / DNS 失败不再触发 Windows PowerShell 回退（原本会让等待翻倍）。
- `archiveApi`：超时后不再重试（重试只对非超时错误生效）。

### 2. 全站搜索被 archive.org 拖死

- `movies.ts`：VOD 侧 7 s 总预算、archive 侧 2.5 s 独立预算，用 `AbortSignal.timeout` 真正可取消。
- `vodApi.ts`：12 路并发池替代「4 批串行等待」，单站搜索超时 6 s；超时后返回已拿到的部分结果，不再整体失败。

### 3. 失败结果不缓存 / 无并发合并

`memoryCache.ts` 重写：失败结果写负缓存（默认 20 s，archive 30 s），同 key 并发请求合并为一次上游调用。

### 4. Electron 打包版卡死

- `desktop/main.mjs`：检测到端口后不再 `off('data')`，保持消费 stdout（消除管道背压阻塞）；stderr 只保留最后 8 KB。
- `server.ts`：请求日志改为 `LOG_REQUESTS=1` 才输出；启动行同时匹配 `127.0.0.1:端口`。

### 5. 局域网暴露面

- `server.ts`：默认 `listen({ host: '127.0.0.1' })`，需要局域网访问时显式 `HOST=0.0.0.0`。
- `routes/stream.ts`、`routes/images.ts`：改用 `parseProxyUrl()`，拒绝 localhost / 私网 / 链路本地 / CGNAT 地址（实测返回 400）。

## 三、P1 优化

| # | 内容 | 结果 |
|---|---|---|
| 1 | `config.json` 站点去重 | 删除 12 组同主机重复 key，外加非 MacCMS 的 `yparse` 与名为 `test` 的 `danaizi`；49 → **35** 个 VOD 站，同主机重复 0 |
| 2 | 延迟探测按需 | `Header.tsx` 不再启动即探测；`SourceSelect` 首次展开下拉框才请求；后端加 in-flight 合并 + `latency.json` 落盘（30 分钟内复用） |
| 3 | 首屏代码分割 | `App.tsx` 对详情 / 站点 / 历史页 `lazy()`；`vite.config.ts` 拆 `hls`、`react` 两个 chunk |
| 4 | 静态资源缓存 | `/assets` 设 `immutable, max-age=1y`；其余静态资源 1 h；SPA fallback 保持 `max-age=0` 以便更新后生效 |
| 5 | 图片代理 | 8 MB 上限、10 分钟内存缓存（200 条上限）、并发上限 6、`Content-Length` 预检 |

## 四、P2 代码质量

| # | 内容 | 位置 |
|---|---|---|
| 1 | `timeupdate` 只在整秒变化时 setState（避免选集列表每 250 ms 重渲染） | `VideoPlayer.tsx` |
| 2 | `Partial<Hls['config']>` → `Partial<HlsConfig>` | `VideoPlayer.tsx` |
| 3 | 片头/片尾跳过默认值 90 s → **0 s**（不再自动跳过正片开头） | `playerSettings.ts` |
| 4 | 列表加载抽 `loadList()`，`AbortController` 替代 `cancelled` 标志，失败时清空旧列表 | `Home.tsx` |
| 5 | 新增 404 路由与顶层 `ErrorBoundary` | `App.tsx`、`ErrorBoundary.tsx` |
| 6 | 删除未使用的 `DEFAULT_PORT` | `server.ts` |
| 7 | 新增 `typecheck` / `test` 脚本；补 `parsePlayUrls` 5 个单测 | `package.json`、`vodApi.test.ts` |
| 8 | 配置写入原子化（`.tmp` + `renameSync`） | `config.ts` |
| 9 | 配置读取容错（解析失败回退默认配置并打印路径） | `config.ts` |
| 10 | README 补两套后端产物说明 | `README.md` |
| 11 | README 站点数量改为「约 35 个（按 API 主机去重后）」 | `README.md` |
| 12 | `.gitignore` 增加 `latency.json`、`config.json.tmp` | `.gitignore` |

## 五、单测发现并修复的真实缺陷

`parsePlayUrls` 的 `normalizeStreamUrl` 正则 `[^/]+$` 会把**已带扩展名**的极速播放地址也追加 `/index.m3u8`（如 `.../play/abc.mp4` → `.../play/abc.mp4/index.m3u8`）。改为 `[^/.]+$`，只对真正的 play 页补全。

## 六、验证记录

```
npm run typecheck   → 前后端均通过
npm test            → 5 / 5 通过
npm run build       → tsc + vite 构建通过（hls chunk 594 KB 为懒加载，体积告警可忽略）
node --check desktop/main.mjs → 通过
```

接口验证：

- `/api/health` 200
- `/api/movies/sources` 200，36 个源，默认 `dyttzy`
- `/api/movies?source=dyttzy` 200，20 条
- `/api/movies/dyttzy:76509` 200，44 个播放地址
- `/api/stream?url=<真实 m3u8>` 200，`application/vnd.apple.mpegurl`，分片已改写为本地代理
- `/api/img?url=http://127.0.0.1:3999/...` → 400（私网拦截生效）
- `/api/stream?url=http://192.168.1.1/...` → 400

## 七、未执行项

1. **Git 历史重写**：`.git` 约 290 MB，历史含 4 个 ~74 MB 的 exe blob。需 `git filter-repo --path release --invert-paths` 后强推，会使已有克隆失效。属破坏性操作，未执行。
2. **Electron 实际打包与播放验证**：`npm run pack:win` 需下载 Electron 二进制，耗时较长；本次只做了构建与入口语法检查。
3. **根目录临时文件**：`tmp-*.json`、`tmp-play.html`、`test-proxy.m3u8` 已被 `.gitignore` 忽略，未删除（属用户现场数据，建议自行确认后清理）。
