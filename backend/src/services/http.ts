// 上游 HTTP 公共工具：超时信号、取消合并、代理目标校验
//
// 注意：项目使用 node-fetch v3，该版本已移除 `timeout` 选项，只认 `signal`。
// 所有上游 fetch 都必须走 timeoutSignal()，否则超时会退化到 TCP 层（可达 60s+）。

import http from 'node:http';
import { isIP } from 'node:net';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

/** 生成带超时的取消信号 */
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** 合并多个取消信号；全部为空时返回 undefined */
export function mergeSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/**
 * 是否禁止访问的主机（本机 / 内网 / 链路本地）。
 * 域名一律放行——资源站都是域名，且 DNS 解析成本高。
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const kind = isIP(host);
  if (kind === 0) return false;
  return kind === 4 ? isPrivateIPv4(host) : isPrivateIPv6(host);
}

/** 代理类接口（/api/stream、/api/img）的统一目标校验 */
export function parseProxyUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (isBlockedHost(url.hostname)) return null;
  return url;
}

type AnyAgent = http.Agent;

const proxyAgentCache = new Map<string, AnyAgent>();

/**
 * 为「经代理访问某目标」创建并缓存 agent。
 * 目标为 https 时必须用 HttpsProxyAgent（CONNECT 隧道），http 目标用 HttpProxyAgent。
 * rejectUnauthorized:false 是为了兼容资源站的自签证书。
 */
export function createProxyAgent(targetUrl: string, proxyUrl: string): AnyAgent {
  const isHttpsTarget = targetUrl.startsWith('https:');
  const key = `${proxyUrl}|${isHttpsTarget ? 'tls' : 'plain'}`;
  const hit = proxyAgentCache.get(key);
  if (hit) return hit;

  let agent: AnyAgent;
  if (/^socks/i.test(proxyUrl)) {
    agent = new SocksProxyAgent(proxyUrl) as unknown as AnyAgent;
  } else if (isHttpsTarget) {
    agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false }) as unknown as AnyAgent;
  } else {
    agent = new HttpProxyAgent(proxyUrl) as unknown as AnyAgent;
  }

  // 配置改动后 proxyUrl 会变，缓存按新 key 自然隔离；超限时整体清空避免泄漏
  if (proxyAgentCache.size > 40) proxyAgentCache.clear();
  proxyAgentCache.set(key, agent);
  return agent;
}
