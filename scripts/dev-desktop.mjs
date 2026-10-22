/**
 * 开发模式一键启动：后端(tsx watch) + 前端(Vite dev) + Electron 桌面壳。
 * Electron 直接加载 Vite 地址，改代码即时热更新，不需要打包。
 * 用法：npm run dev:desktop
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const nodeBin = process.execPath;
const electronBin = require('electron');

const DEV_PORT = Number(process.env.PDC_DEV_PORT) || 5173;
const BACKEND_PORT = Number(process.env.PORT) || 3002;
const devUrl = `http://127.0.0.1:${DEV_PORT}`;

/** 子进程共享的干净环境：去掉 ELECTRON_RUN_AS_NODE，避免 Electron 被当成 Node 跑 */
const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;
delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;

const children = [];

function launch(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...baseEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const prefix = `[${name}] `;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`${prefix}退出，代码 ${code}`);
  });
  children.push(child);
  return child;
}

function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`等待超时：${url}`));
      setTimeout(tick, 400);
    };
    tick();
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`开发模式启动：后端 :${BACKEND_PORT} / 前端 ${devUrl}`);

launch(
  'backend',
  nodeBin,
  [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', 'src/server.ts'],
  path.join(root, 'backend'),
  { PORT: String(BACKEND_PORT), NODE_ENV: 'development' },
);

launch(
  'frontend',
  nodeBin,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(DEV_PORT),
    '--strictPort',
  ],
  path.join(root, 'frontend'),
);

try {
  await waitFor(`${devUrl}/api/health`);
  console.log('前后端就绪，启动 Electron 桌面壳');
  const electronArgs = [path.join(root, 'desktop/main.mjs')];
  if (process.env.PDC_REMOTE_DEBUG) {
    electronArgs.unshift(`--remote-debugging-port=${process.env.PDC_REMOTE_DEBUG}`);
  }
  // 远程/无显卡环境可传 PDC_ELECTRON_FLAGS="--no-sandbox --disable-gpu"
  const extraFlags = (process.env.PDC_ELECTRON_FLAGS || '').split(/\s+/).filter(Boolean);
  electronArgs.unshift(...extraFlags);
  const electron = launch('electron', electronBin, electronArgs, root, {
    PDC_DEV_URL: devUrl,
  });
  electron.on('exit', (code) => {
    console.log('Electron 已退出，关闭开发服务');
    shutdown(code ?? 0);
  });
} catch (err) {
  console.error(String(err.message || err));
  shutdown(1);
}
