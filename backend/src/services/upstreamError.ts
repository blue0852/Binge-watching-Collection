/** 将上游错误转为用户可读短句，避免泄露脚本/HTML */

const WAF_HINT =
  '资源站启用了访问防护（如 Cloudflare），当前环境无法拉取数据，请换其他资源站或稍后重试';

function looksLikeWafOrHtml(raw: string): boolean {
  const s = raw.toLowerCase();
  return (
    s.includes('cloudflare') ||
    s.includes('cf-chl') ||
    s.includes('just a moment') ||
    s.includes('enable javascript and cookies') ||
    s.includes('上游返回 html') ||
    s.includes('<!doctype') ||
    s.includes('<html')
  );
}

function looksLikeInternalLeak(raw: string): boolean {
  return (
    raw.includes('powershell.exe') ||
    raw.includes('Invoke-WebRequest') ||
    raw.includes('$ErrorActionPreference') ||
    raw.length > 400
  );
}

function extractHttpStatus(raw: string): number | null {
  const m = raw.match(/(?:上游请求失败:\s*|HTTP[_\s]?)(\d{3})/i);
  return m ? Number(m[1]) : null;
}

/** 供 API 返回给前端的 detail 文案 */
export function formatUpstreamErrorMessage(err: Error): string {
  const raw = err.message;
  if (looksLikeWafOrHtml(raw) || looksLikeInternalLeak(raw)) {
    const status = extractHttpStatus(raw);
    if (status === 403 || looksLikeWafOrHtml(raw)) return WAF_HINT;
    if (status === 401) return '资源站拒绝访问（401），该 API 可能已失效或需鉴权';
    if (status === 429) return '请求过于频繁（429），请稍后重试';
    if (status === 404) return '资源站接口不存在（404），请检查 config 中的 API 地址';
    return WAF_HINT;
  }

  const status = extractHttpStatus(raw);
  if (status === 403) return WAF_HINT;
  if (status === 401) return '资源站拒绝访问（401），该 API 可能已失效或需鉴权';
  if (status === 429) return '请求过于频繁（429），请稍后重试';

  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 160) return oneLine;
  return `${oneLine.slice(0, 160)}…`;
}

/** Node 收到明确 HTTP 状态时不应再 Windows 回退（通常无效且会泄露大段错误） */
export function shouldSkipWindowsFallback(err: Error): boolean {
  const status = extractHttpStatus(err.message);
  if (status !== null && [401, 403, 404, 429].includes(status)) return true;
  if (looksLikeWafOrHtml(err.message)) return true;
  return false;
}
