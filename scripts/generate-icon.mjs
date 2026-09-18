/**
 * 从 build/icon.svg 生成 Windows .ico 与 PNG（electron-builder / 窗口图标）
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const svgPath = path.join(root, 'build', 'icon.svg');
const svg = readFileSync(svgPath);

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngBuffers = await Promise.all(
  icoSizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()),
);

const icoPath = path.join(root, 'build', 'icon.ico');
writeFileSync(icoPath, await pngToIco(pngBuffers));

const png512 = path.join(root, 'build', 'icon.png');
await sharp(svg).resize(512, 512).png().toFile(png512);

const desktopIco = path.join(root, 'desktop', 'icon.ico');
copyFileSync(icoPath, desktopIco);

console.log('✓ build/icon.ico, build/icon.png, desktop/icon.ico');
