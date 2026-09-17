import { app, BrowserWindow, dialog } from 'electron';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const appRoot = isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.resolve(__dirname, '..');

let mainWindow = null;
let serverProcess = null;
let serverPort = 3002;

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

function startBackend() {
  const serverEntry = path.join(appRoot, 'backend/dist/server.js');
  const backendDir = path.join(appRoot, 'backend/dist');
  const nodeModules = path.join(appRoot, 'backend/node_modules');

  serverProcess = fork(serverEntry, [], {
    cwd: backendDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      APP_ROOT: appRoot,
      CONFIG_PATH: path.join(appRoot, 'config.json'),
      FRONTEND_DIST: path.join(appRoot, 'frontend/dist'),
      PORT: '0',
      NODE_PATH: nodeModules,
    },
    stdio: 'pipe',
  });

  return new Promise((resolve, reject) => {
    let stderr = '';
    serverProcess.stderr?.on('data', (buf) => {
      stderr += buf.toString();
    });
    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(stderr || `后端进程异常退出 (${code})`));
      }
    });

    const onStdout = (buf) => {
      const text = buf.toString();
      const m = text.match(/localhost:(\d+)/);
      if (m) {
        serverPort = Number(m[1]);
        serverProcess.stdout?.off('data', onStdout);
        waitForHealth(serverPort).then(resolve).catch(reject);
      }
    };
    serverProcess.stdout?.on('data', onStdout);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Public Domain Cinema',
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
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
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
