import { app, net, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 自动更新（三个模式）：
 * - auto   ：NSIS 安装版，走 electron-updater，可后台下载 + 重启安装
 * - manual ：便携版，单文件 exe 没有安装目录，只能查版本 + 跳转下载页
 * - dev    ：开发模式，不检查
 */

const OWNER = 'blue0852';
const REPO = 'Binge-watching-Collection';
const RELEASES_LATEST = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const API_LATEST = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 256 * 1024;

let autoUpdater = null;
let broadcast = () => {};
let firstTimer = null;
let intervalTimer = null;
let busy = false;

const state = {
  mode: 'dev',
  status: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  notes: '',
  message: '',
  releaseUrl: RELEASES_LATEST,
};

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'update.log');
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) writeFileSync(file, '');
    appendFileSync(file, text, 'utf8');
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

function emit(patch) {
  Object.assign(state, patch);
  try {
    broadcast({ ...state });
  } catch {
    /* 窗口可能已销毁 */
  }
}

function parseVersion(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function describeError(err) {
  const raw = err?.message || String(err || '未知错误');
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN/.test(raw)) {
    return `网络不可达：${raw}`;
  }
  if (/404|Cannot find/i.test(raw)) {
    return `找不到更新清单：${raw}`;
  }
  return raw;
}

/** 便携版：只查 GitHub Release 版本号，给出下载入口 */
async function checkViaApi() {
  emit({ status: 'checking', message: '正在检查更新…' });
  try {
    const res = await net.fetch(API_LATEST, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Public-Domain-Cinema/${app.getVersion()}`,
      },
    });
    if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
    const data = await res.json();
    const latest = String(data?.tag_name || '').replace(/^v/i, '');
    if (latest && isNewer(latest, app.getVersion())) {
      emit({
        status: 'available',
        latestVersion: latest,
        notes: typeof data?.body === 'string' ? data.body.slice(0, 2000) : '',
        releaseUrl: data?.html_url || RELEASES_LATEST,
        message: `发现新版本 ${latest}`,
      });
      log(`api check: available ${latest}`);
    } else {
      emit({ status: 'up-to-date', latestVersion: latest || state.latestVersion, message: '已是最新版本' });
      log(`api check: up-to-date (latest=${latest || 'unknown'})`);
    }
  } catch (err) {
    const msg = describeError(err);
    emit({ status: 'error', message: `检查失败：${msg}` });
    log(`api check error: ${msg}`);
  }
  return { ...state };
}

async function loadAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  const mod = await import('electron-updater');
  const updater = mod?.autoUpdater || mod?.default?.autoUpdater;
  if (!updater) throw new Error('electron-updater 加载失败');
  autoUpdater = updater;
  return updater;
}

export function initUpdater({ isPackaged, portable, onState }) {
  if (typeof onState === 'function') broadcast = onState;
  emit({ currentVersion: app.getVersion() });

  if (!isPackaged) {
    emit({ mode: 'dev', status: 'idle', message: '' });
    log('init: dev mode, updater disabled');
    return;
  }

  if (portable) {
    emit({ mode: 'manual', status: 'idle', message: '便携版不做后台更新，可手动检查新版本' });
    log('init: portable mode (manual check only)');
    return;
  }

  emit({ mode: 'auto', status: 'idle' });
  log(`init: auto mode, version=${app.getVersion()}`);

  void loadAutoUpdater()
    .then((updater) => {
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = true;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      updater.logger = {
        info: (m) => log(`[updater] ${m}`),
        warn: (m) => log(`[updater][warn] ${m}`),
        error: (m) => log(`[updater][error] ${m}`),
        debug: () => {},
      };

      updater.on('checking-for-update', () => emit({ status: 'checking', message: '正在检查更新…' }));
      updater.on('update-available', (info) => {
        emit({
          status: 'available',
          latestVersion: info?.version || null,
          notes: typeof info?.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : '',
          message: `发现新版本 ${info?.version || ''}`.trim(),
        });
        log(`event: update-available ${info?.version}`);
      });
      updater.on('update-not-available', (info) => {
        emit({
          status: 'up-to-date',
          latestVersion: info?.version || state.latestVersion,
          message: '已是最新版本',
        });
        log('event: update-not-available');
      });
      updater.on('download-progress', (p) => {
        emit({
          status: 'downloading',
          percent: Math.round((p?.percent || 0) * 10) / 10,
          transferred: p?.transferred || 0,
          total: p?.total || 0,
          bytesPerSecond: p?.bytesPerSecond || 0,
          message: '正在下载更新…',
        });
      });
      updater.on('update-downloaded', (info) => {
        emit({
          status: 'downloaded',
          latestVersion: info?.version || state.latestVersion,
          percent: 100,
          message: '更新已下载，重启后安装',
        });
        log(`event: update-downloaded ${info?.version}`);
      });
      updater.on('error', (err) => {
        const msg = describeError(err);
        emit({ status: 'error', message: `更新出错：${msg}` });
        log(`event: error ${msg}`);
      });
    })
    .catch((err) => {
      emit({ status: 'error', message: `更新模块不可用：${describeError(err)}` });
      log(`init error: ${describeError(err)}`);
    });
}

export async function checkForUpdates() {
  if (state.mode === 'dev') return { ...state };
  if (state.mode === 'manual') return checkViaApi();
  if (busy) return { ...state };

  busy = true;
  try {
    const updater = await loadAutoUpdater();
    emit({ status: 'checking', message: '正在检查更新…' });
    await updater.checkForUpdates();
  } catch (err) {
    const msg = describeError(err);
    emit({ status: 'error', message: `检查失败：${msg}` });
    log(`check error: ${msg}`);
  } finally {
    busy = false;
  }
  return { ...state };
}

export async function downloadUpdate() {
  if (state.mode === 'manual') {
    await shell.openExternal(state.releaseUrl || RELEASES_LATEST);
    return { ...state };
  }
  if (state.mode !== 'auto') return { ...state };

  try {
    const updater = await loadAutoUpdater();
    emit({ status: 'downloading', percent: 0, message: '开始下载…' });
    await updater.downloadUpdate();
  } catch (err) {
    const msg = describeError(err);
    emit({ status: 'error', message: `下载失败：${msg}` });
    log(`download error: ${msg}`);
  }
  return { ...state };
}

export function installUpdate() {
  if (state.mode !== 'auto' || state.status !== 'downloaded' || !autoUpdater) return false;
  log('action: quitAndInstall');
  // 让 IPC 先返回，避免渲染进程在退出过程中被销毁而报错
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      log(`quitAndInstall error: ${describeError(err)}`);
    }
  });
  return true;
}

export async function openReleases() {
  await shell.openExternal(state.releaseUrl || RELEASES_LATEST);
}

export function getUpdateState() {
  return { ...state };
}

export function startAutoCheck() {
  if (state.mode !== 'auto') return;
  if (firstTimer || intervalTimer) return;
  firstTimer = setTimeout(() => {
    void checkForUpdates();
    intervalTimer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
    intervalTimer.unref?.();
  }, FIRST_CHECK_DELAY_MS);
  firstTimer.unref?.();
}
