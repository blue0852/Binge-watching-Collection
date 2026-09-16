/** 浏览器直连更可靠的图床（服务端代理常失败） */
const DIRECT_IMAGE_HOSTS = [/zuidapic\.com/i, /zuidapi\.com/i];

/** 外部封面：能直连则直连，否则走后端代理 */
export function proxyImageUrl(url: string): string {
  if (!url) return '';
  if (url.includes('archive.org')) return url;
  if (DIRECT_IMAGE_HOSTS.some((re) => re.test(url))) return url;
  return `/api/img?url=${encodeURIComponent(url)}`;
}
