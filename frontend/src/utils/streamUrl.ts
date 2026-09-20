/** 外部播放地址走后端代理（绕过 CDN 防盗链 / CORS / 自签证书） */
export function proxyStreamUrl(url: string): string {
  if (!url) return '';
  if (url.includes('archive.org')) return url;
  if (url.startsWith('/api/stream')) return url;
  return `/api/stream?url=${encodeURIComponent(url)}`;
}
