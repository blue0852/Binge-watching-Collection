/** 列表页 URL 上需要带回详情页的查询参数 */
const LIST_QUERY_KEYS = ['source', 'type', 'page', 'q', 'scope'] as const;

export function buildListUrl(params: URLSearchParams): string {
  const next = new URLSearchParams();
  for (const key of LIST_QUERY_KEYS) {
    const value = params.get(key);
    if (value) next.set(key, value);
  }
  const qs = next.toString();
  return qs ? `/?${qs}` : '/';
}
