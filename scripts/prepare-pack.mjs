/**
 * 准备 Electron 打包目录 pack/app
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const packRoot = path.join(root, 'pack', 'app');

console.log('→ 清理 pack/app …');
rmSync(path.join(root, 'pack'), { recursive: true, force: true });
mkdirSync(packRoot, { recursive: true });

console.log('→ 复制后端、前端、配置 …');
cpSync(path.join(root, 'backend', 'dist'), path.join(packRoot, 'backend', 'dist'), {
  recursive: true,
});
cpSync(path.join(root, 'frontend', 'dist'), path.join(packRoot, 'frontend', 'dist'), {
  recursive: true,
});
cpSync(path.join(root, 'config.json'), path.join(packRoot, 'config.json'));

const backendPkg = {
  name: 'public-domain-cinema-backend',
  private: true,
  type: 'module',
  dependencies: {
    express: '^4.21.2',
    'node-fetch': '^3.3.2',
  },
};
writeFileSync(
  path.join(packRoot, 'backend', 'package.json'),
  JSON.stringify(backendPkg, null, 2),
);

console.log('→ 安装后端运行时依赖 …');
execSync('npm install --omit=dev --no-audit --no-fund', {
  cwd: path.join(packRoot, 'backend'),
  stdio: 'inherit',
});

console.log('✓ pack/app 已就绪');
