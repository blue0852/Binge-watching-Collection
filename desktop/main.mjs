import { app, BrowserWindow, dialog } from 'electron';
import { fork } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const appRoot = isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.resolve(__dirname, '..');

if (isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', process.env.PORTABLE_EXECUTABLE_DIR);
}

let mainWindow = null;
let serverProcess = null;
let serverPort = 3002;

/** 便携版：exe 同目录；安装版：userData */
function getPersistentDataDir() {
  if (!isPackaged) return app.getPath('userData');
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  return portableDir || app.getPath('userData');
}

const SERVER_PORT_FILE = 'server-port.json';

function readSavedServerPort() {
  if (!isPackaged) return null;
  const portPath = path.join(getPersistentDataDir(), SERVER_PORT_FILE);
  try {
    if (!existsSync(portPath)) return null;
    const data = JSON.parse(readFileSync(portPath, 'utf8'));
    const port = Number(data?.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    /* ignore */
  }
  return null;
}

function writeSavedServerPort(port) {
  if (!isPackaged) return;
  const dir = getPersistentDataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, SERVER_PORT_FILE), JSON.stringify({ port }), 'utf8');
}

/** 开发：项目根 config.json；便携版：exe 同目录；安装版：userData（Program Files 不可写） */
function resolveConfigPath() {
  const bundledConfigPath = path.join(appRoot, 'config.json');
  if (!isPackaged) {
    if (process.env.CONFIG_PATH && existsSync(process.env.CONFIG_PATH)) {
      return process.env.CONFIG_PATH;
    }
    return bundledConfigPath;
  }

  const configDir = getPersistentDataDir();
  const userConfigPath = path.join(configDir, 'config.json');

  if (!existsSync(userConfigPath)) {
    mkdirSync(configDir, { recursive: true });
    const legacyPath = path.join(app.getPath('userData'), 'config.json');
    const seedPath = existsSync(legacyPath) ? legacyPath : bundledConfigPath;
    copyFileSync(seedPath, userConfigPath);
  }
  return userConfigPath;
}

function waitForHealth(port, retries = 40) {
  return new Promise((resolve, reject) => {
    let left = retries;
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      left -= 1;
      if (left <= 0) reject(new Error('服务启动超时'));
      else setTimeout(tick, 500);
    };
    tick();
  });
}

function forkBackend(portEnv) {
  const backendRoot = path.join(appRoot, 'backend');
  const bundledEntry = path.join(backendRoot, 'dist/server.bundle.mjs');
  const fallbackEntry = path.join(backendRoot, 'dist/server.js');
  const serverEntry = existsSync(bundledEntry) ? bundledEntry : fallbackEntry;

  serverProcess = fork(serverEntry, [], {
    cwd: path.join(backendRoot, 'dist'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      APP_ROOT: appRoot,
      CONFIG_PATH: resolveConfigPath(),
      FRONTEND_DIST: path.join(appRoot, 'frontend/dist'),
      PORT: String(portEnv),
    },
    stdio: 'pipe',
  });

  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    let portResolved = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    serverProcess.stderr?.on('data', (buf) => {
      // 只保留最后 8KB，长跑不会无限吃内存
      stderr = (stderr + buf.toString()).slice(-8192);
    });
    serverProcess.on('error', fail);
    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null && !settled) {
        const err = new Error(stderr || `后端进程异常退出 (${code})`);
        if (/EADDRINUSE|address already in use/i.test(stderr)) {
          err.code = 'EADDRINUSE';
        }
        fail(err);
      }
    });

    // 必须持续消费 stdout：一旦停止读取，子进程 console.log 会因管道背压阻塞整个事件循环
    serverProcess.stdout?.on('data', (buf) => {
      if (portResolved) return;
      const m = buf.toString().match(/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (!m) return;
      portResolved = true;
      serverPort = Number(m[1]);
      waitForHealth(serverPort).then(succeed).catch(fail);
    });
  });
}

function stopBackendProcessOnly() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

/** 桌面版复用同一 localhost 端口，否则 localStorage（播放历史等）会因 origin 变化而读不到 */
async function startBackend() {
  const savedPort = readSavedServerPort();
  const attempts = savedPort != null ? [savedPort, 0] : [0];
  let lastErr;
  for (const port of attempts) {
    try {
      await forkBackend(port);
      writeSavedServerPort(serverPort);
      return;
    } catch (err) {
      lastErr = err;
      stopBackendProcessOnly();
      if (err.code !== 'EADDRINUSE' || port === 0) throw err;
    }
  }
  throw lastErr;
}

function createWindow() {
  const windowIcon = path.join(__dirname, 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Public Domain Cinema',
    icon: windowIcon,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function stopBackend() {
  stopBackendProcessOnly();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startBackend();
      createWindow();
    } catch (err) {
      let msg = String(err.message || err);
      if (/EADDRINUSE|3002/.test(msg)) {
        msg += '\n\n请关闭正在运行的 npm start / 其他本程序实例，或重新打包后 exe 会自动使用空闲端口。';
      }
      dialog.showErrorBox('启动失败', msg);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    stopBackend();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', stopBackend);
}
