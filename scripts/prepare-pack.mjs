/**
 * 准备 Electron 打包目录 pack/app
 */
import { cpSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const packRoot = path.join(root, 'pack', 'app');
const backendDistSrc = path.join(root, 'backend', 'dist');
const backendDistPack = path.join(packRoot, 'backend', 'dist');
const serverBundle = path.join(backendDistPack, 'server.bundle.mjs');

console.log('→ 清理 pack/app …');
try {
  rmSync(packRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
} catch {
  const staleRoot = path.join(root, 'pack', `_stale_${Date.now()}`);
  try {
    renameSync(packRoot, staleRoot);
    rmSync(staleRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  } catch {
    console.warn('⚠ 无法完全删除旧 pack/app，将覆盖写入');
  }
}
mkdirSync(packRoot, { recursive: true });

console.log('→ 复制后端、前端、配置 …');
cpSync(backendDistSrc, backendDistPack, { recursive: true });
cpSync(path.join(root, 'frontend', 'dist'), path.join(packRoot, 'frontend', 'dist'), {
  recursive: true,
});
cpSync(path.join(root, 'config.json'), path.join(packRoot, 'config.json'));

console.log('→ 打包后端为单文件（含 express 等依赖）…');
buildSync({
  entryPoints: [path.join(backendDistSrc, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: serverBundle,
  packages: 'bundle',
  logLevel: 'info',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

if (!statSync(serverBundle).isFile()) {
  throw new Error('后端打包失败：未生成 server.bundle.mjs');
}

console.log('✓ pack/app 已就绪');
