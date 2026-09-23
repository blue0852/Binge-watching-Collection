# Public Domain Cinema v1.0.3

Windows 桌面版（内置本地服务，无需单独安装 Node.js）。

## 下载

| 文件 | 说明 |
|------|------|
| `Public Domain Cinema-1.0.3-portable.exe` | **便携版**：解压即用，配置保存在 exe 同目录的 `config.json` |
| `Public Domain Cinema-1.0.3-setup.exe` | **安装版**：配置保存在 `%APPDATA%\Public Domain Cinema\config.json` |

> 安装包未做代码签名，Windows 可能提示「未知发布者」，选择仍要运行即可。

### 本版更新

- **资源站延迟**：顶栏与站点管理页显示各站探测延迟（绿/黄/红），便于选站。
- **资源站下拉**：自定义选择器展示延迟；下拉列表完整站名、隐藏滚动条。
- **上游错误提示**：403 / Cloudflare 等返回简短中文说明，不再暴露 PowerShell 或整页 HTML。
- **列表封面**：批量补封面失败时仍展示列表（无缩略图），避免整页报错。

## 功能概览

- 多资源站切换、分类筛选、搜索与分页
- 详情页多线路 / 选集，m3u8 使用 hls.js
- 播放历史、片头片尾跳过、顶栏缓存刷新
- 站点管理与 `config.json` 配置

## 从源码构建

```bash
npm install
npm run pack:win
```

产物位于 `release/` 目录（不纳入 Git，请在本 Release 附件中下载 exe）。
