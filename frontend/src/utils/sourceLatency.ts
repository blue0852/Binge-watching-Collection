/** 格式化资源站延迟显示 */
export function formatSourceLatency(ms: number | null | undefined): string {
  if (ms == null) return '超时';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 低延迟绿色，中等黄色，高延迟/超时红色 */
export function sourceLatencyClass(
  ms: number | null | undefined,
  pending = false,
): string {
  if (pending) return 'latency-pending';
  if (ms == null) return 'latency-bad';
  if (ms < 400) return 'latency-good';
  if (ms < 1200) return 'latency-mid';
  return 'latency-bad';
}
