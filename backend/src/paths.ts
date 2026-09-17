import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 应用根目录（开发：项目根；打包：resources/app） */
export function getAppRoot(): string {
  return process.env.APP_ROOT || path.resolve(__dirname, '../..');
}

export function getConfigPath(): string {
  return process.env.CONFIG_PATH || path.join(getAppRoot(), 'config.json');
}

export function getFrontendDistPath(): string {
  return process.env.FRONTEND_DIST || path.join(getAppRoot(), 'frontend/dist');
}
