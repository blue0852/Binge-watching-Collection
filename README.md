# Public Domain Cinema · 在线影视聚合

聚合 **Internet Archive 公有领域影视** 与 **config.json 配置的 MacCMS 风格 VOD 资源站**，支持搜索、分类筛选与在线播放（mp4 / HLS）。

## 功能概览

- **多资源站切换**：顶部下拉选择数据源（默认「电影天堂」），含 Internet Archive 与约 56 个已探测可用的 VOD 站
- **分类标签**：按资源站返回的 `class` 分类筛选（无 `type_pid` 的站点以扁平标签展示）
- **搜索与分页**：关键词搜索、加载更多
- **详情播放**：选集 / 多线路；m3u8 使用 [hls.js](https://github.com/video-dev/hls.js)
- **封面代理**：部分图床浏览器直连，其余经 `/api/img` 代理

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18、Vite、TypeScript、React Router、hls.js |
| 后端 | Node.js、Express、TypeScript、node-fetch |
| 配置 | 根目录 `config.json`（`cache_time`、`api_site`） |

## 快速开始

```bash
npm install
npm run dev
```

| 服务 | 地址 |
|------|------|
| 前端（开发） | http://localhost:5173 |
| 后端 API | http://localhost:3002/api |

生产环境：

```bash
npm run build
npm start
# 访问 http://localhost:3002
```

## 打包为 Windows exe

使用 Electron 将前后端与 `config.json` 打成桌面应用（内置本地服务，无需单独安装 Node.js）：

```bash
npm install
# 国内网络建议先设置镜像（PowerShell）：
# $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
# $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run pack:win
```

产物在 `release/` 目录：

| 文件 | 说明 |
|------|------|
| `Public Domain Cinema-1.0.0-portable.exe` | 绿色便携版，双击即用 |
| `Public Domain Cinema-1.0.0-setup.exe` | 安装版 |

仅生成未压缩目录（调试打包用）：`npm run pack:dir`

打包前会自动执行 `npm run build` 与 `prepare:pack`（复制构建产物并在 `pack/app` 安装后端运行时依赖）。首次打包会下载 Electron，体积约 150MB+，属正常现象。

## 项目结构

```
public-domain-cinema/
├── config.json           # VOD 资源站列表与缓存 TTL
├── scripts/
│   └── check-sites.mjs   # 探测可用站点并写回 config.json
├── backend/
│   └── src/
│       ├── config.ts     # 读取 config.json
│       ├── routes/       # movies、images（封面代理）
│       └── services/     # archiveApi、vodApi
└── frontend/
    └── src/
        ├── pages/        # Home、MovieDetail
        └── components/   # Header、CategoryBar、VideoPlayer、MovieCard
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/movies/sources` | 资源站列表 |
| GET | `/api/movies/categories?source=dyttzy` | VOD 分类标签 |
| GET | `/api/movies?source=dyttzy&page=1&type=6` | 列表（`type` 为分类 ID） |
| GET | `/api/movies/search?q=关键词&source=dyttzy` | 搜索 |
| GET | `/api/movies/:id` | 详情（Archive：`identifier`；VOD：`站点key:vod_id`） |
| GET | `/api/img?url=...` | 外部封面图代理 |
| GET | `/api/health` | 健康检查 |

### 查询参数说明

- **`source`**：资源站 key，`archive` 为 Internet Archive；省略时 VOD 默认 `dyttzy`
- **`type`**：MacCMS 分类 `type_id`，仅对 VOD 列表生效
- **`page` / `rows`**：分页

## 配置与维护

### config.json

```json
{
  "cache_time": 7200,
  "api_site": {
    "dyttzy": {
      "api": "http://.../api.php/provide/vod",
      "name": "电影天堂",
      "detail": "http://..."
    }
  }
}
```

- **`cache_time`**：后端内存缓存秒数（列表、分类、详情、封面补全等）
- **`api_site`**：key 为前端/接口使用的 `source`；`api` 为 MacCMS 采集地址

### 清理不可用站点

第三方采集站常变动，可定期执行：

```bash
node scripts/check-sites.mjs
```

脚本会对每个站点请求 `?ac=list&pg=1`（8 秒超时，HTTP 失败时尝试 HTTPS），**直接覆盖** `config.json`，仅保留返回 `code: 1` 且含列表/分类数据的站点。执行前请自行备份配置。

## 数据源

### Internet Archive（`source=archive`）

- 搜索：`https://archive.org/advancedsearch.php`
- 元数据：`https://archive.org/metadata/<id>`
- 缩略图：`https://archive.org/services/img/<id>`
- 视频：`https://archive.org/download/<id>/<file>`

仅聚合官方公开 API 与 CDN 直链，不存储视频文件。Archive 内容多为公有领域或知识共享许可，详见 [archive.org](https://archive.org)。

### VOD 资源站

由 `config.json` 指向的第三方 MacCMS 接口聚合，**版权与合规性由各自站点负责**；本项目仅作技术演示与接口代理，不托管媒资。

## 限制说明

- 依赖上游 API / CDN 可用性，部分资源站会 404、超时或防盗链
- 列表接口常不含封面，后端会批量请求 `ac=detail` 补全；部分图床仅浏览器可访问
- 极速等站的 `vod_play_url` 使用 `$$$` 分隔，解析时需用正则 `split(/\$\$\$/)`（见 `vodApi.ts`）
- 未实现用户账号、播放进度同步、收藏等

## 许可与声明

- 项目代码以仓库内声明为准
- 使用 VOD 源时请遵守当地法律法规与版权规定；Archive 模式请优先选择明确公有领域 / CC 许可内容
