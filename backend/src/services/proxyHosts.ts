// 记录「直连不可用、只能走代理」的上游主机。
//
// 目的：playlist / ts 分片 / 封面图这些请求只带 URL，拿不到站点配置，
// 但它们的域名通常与站点 API 同域。API 请求一旦确认必须靠代理，
// 就把 host 记下来，后续同域请求直接代理优先，不再白等直连探测。

const proxyOnlyHosts = new Set<string>();

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** 该 URL 的主机是否已被判定为必须走代理 */
export function isProxyOnlyHost(url: string): boolean {
  const host = hostOf(url);
  return host ? proxyOnlyHosts.has(host) : false;
}

/** 记录某 URL 的主机必须走代理（仅内存，进程重启后重新学习） */
export function markProxyOnlyHost(url: string): void {
  const host = hostOf(url);
  if (!host) return;
  if (proxyOnlyHosts.size > 500) proxyOnlyHosts.clear();
  proxyOnlyHosts.add(host);
}

/** 已学习到的主机数（诊断用） */
export function proxyOnlyHostCount(): number {
  return proxyOnlyHosts.size;
}
