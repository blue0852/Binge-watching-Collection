#!/usr/bin/env node
/**
 * 资源站存活探测 + 去重，用来整理 config.json 的 api_site 列表。
 *
 * 探测方式与后端完全一致（backend/src/services/sourceLatency.ts、vodApi.ts）：
 *   列表：{api}?ac=list&pg=1
 *   搜索：{api}?ac=detail&wd=流浪地球
 * 判定：HTTP 2xx + JSON 可解析 + code 为 1/缺省 + list 是数组。
 *
 * 直连失败时再试一次本地代理（默认 http://127.0.0.1:7897），
 * 这样能区分「站死了」和「只是需要代理」。
 *
 * 用法：
 *   node scripts/probe-sites.mjs --src "F:/path/config copy.json" --out .workbuddy/site-probe
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const SRC = arg('src', '');
const OUT_DIR = arg('out', '.workbuddy/site-probe');
const PROXY = arg('proxy', 'http://127.0.0.1:7897');
const DIRECT_TIMEOUT = Number(arg('timeout', '8')) * 1000;
const PROXY_TIMEOUT = Number(arg('proxy-timeout', '12')) * 1000;
const CONCURRENCY = Number(arg('concurrency', '10'));
const SEARCH_KEYWORD = '流浪地球';

if (!SRC) {
  console.error('缺少 --src');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function withQuery(api, qs) {
  return `${api}${api.includes('?') ? '&' : '?'}${qs}`;
}

function origin(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '';
  }
}

/** 统一成用于比对的标识：小写 host、去端口、去尾斜杠；解开 ?url= 代理包装 */
function normalizeApi(api) {
  const raw = String(api || '').trim();
  try {
    const u = new URL(raw);
    const inner = u.searchParams.get('url');
    if (inner) return normalizeApi(inner);
    const port = u.port && !['80', '443'].includes(u.port) ? `:${u.port}` : '';
    const pathname = u.pathname.replace(/\/+$/, '').toLowerCase();
    const query = u.search ? `?${u.searchParams.toString().toLowerCase()}` : '';
    return `${u.hostname.toLowerCase()}${port}${pathname}${query}`;
  } catch {
    return raw.toLowerCase();
  }
}

async function httpGet(url, { proxy, timeoutMs }) {
  const args = [
    '-sS',
    '-L',
    '--compressed',
    '-m',
    String(Math.ceil(timeoutMs / 1000)),
    '-H',
    `User-Agent: ${UA}`,
    '-H',
    'Accept: application/json,text/plain,*/*',
    '-H',
    `Referer: ${origin(url)}`,
    '-w',
    '\n__META__%{http_code}|%{time_total}',
  ];
  if (proxy) args.push('-x', proxy);
  args.push(url);

  const started = Date.now();
  try {
    const { stdout } = await execFileAsync('curl', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      timeout: timeoutMs + 4000,
    });
    const marker = stdout.lastIndexOf('__META__');
    const body = marker === -1 ? stdout : stdout.slice(0, marker);
    const meta = (marker === -1 ? '' : stdout.slice(marker + 8)).trim();
    const [codeRaw, timeRaw] = meta.split('|');
    return {
      httpStatus: Number(codeRaw) || 0,
      ms: Math.round((Number(timeRaw) || (Date.now() - started) / 1000) * 1000),
      body,
      error: '',
    };
  } catch (e) {
    return {
      httpStatus: 0,
      ms: Date.now() - started,
      body: '',
      error: String(e?.stderr || e?.message || e).trim().slice(0, 200),
    };
  }
}

/** 解析 MacCMS 响应；返回是否可用、条目数、类别数、样本名称 */
function parseVod(body) {
  const text = String(body || '').trim().replace(/^\uFEFF/, '');
  if (!text) return { ok: false, reason: '空响应', count: 0, names: [], classes: 0 };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const head = text.slice(0, 60).replace(/\s+/g, ' ');
    return { ok: false, reason: `非 JSON（${head}）`, count: 0, names: [], classes: 0 };
  }
  if (data?.code !== undefined && Number(data.code) !== 1) {
    return {
      ok: false,
      reason: `code=${data.code} ${String(data.msg || '').slice(0, 40)}`,
      count: 0,
      names: [],
      classes: 0,
    };
  }
  const list = Array.isArray(data?.list) ? data.list : null;
  if (!list) return { ok: false, reason: '无 list 字段', count: 0, names: [], classes: 0 };
  const names = list
    .slice(0, 6)
    .map((v) => String(v?.vod_name || '').trim())
    .filter(Boolean);
  return {
    ok: list.length > 0,
    reason: list.length > 0 ? '' : 'list 为空',
    count: list.length,
    names,
    classes: Array.isArray(data?.class) ? data.class.length : 0,
    total: Number(data?.total) || 0,
  };
}

function fingerprint(names) {
  const clean = names.slice(0, 4).map((n) => n.replace(/\s+/g, ''));
  return clean.length >= 2 ? clean.join('|') : '';
}

/** 单站：先直连，失败再走代理；成功后再验搜索能力 */
async function probe(site) {
  const attempts = [];
  let listResult = null;
  let via = '';

  const direct = await httpGet(withQuery(site.api, 'ac=list&pg=1'), {
    proxy: null,
    timeoutMs: DIRECT_TIMEOUT,
  });
  const directParsed = parseVod(direct.body);
  attempts.push({
    mode: 'direct',
    status: direct.httpStatus,
    ms: direct.ms,
    ok: directParsed.ok,
    reason: directParsed.reason,
    error: direct.error,
  });
  if (directParsed.ok) {
    listResult = directParsed;
    via = 'direct';
  } else {
    const proxied = await httpGet(withQuery(site.api, 'ac=list&pg=1'), {
      proxy: PROXY,
      timeoutMs: PROXY_TIMEOUT,
    });
    const proxiedParsed = parseVod(proxied.body);
    attempts.push({
      mode: 'proxy',
      status: proxied.httpStatus,
      ms: proxied.ms,
      ok: proxiedParsed.ok,
      reason: proxiedParsed.reason,
      error: proxied.error,
    });
    if (proxiedParsed.ok) {
      listResult = proxiedParsed;
      via = 'proxy';
    }
  }

  if (!listResult) {
    const last = attempts[attempts.length - 1];
    return {
      ...site,
      alive: false,
      via: 'dead',
      latency: null,
      searchable: false,
      reason: last?.reason || last?.error || `HTTP ${last?.status}`,
      attempts,
      fingerprint: '',
      listCount: 0,
      total: 0,
    };
  }

  // 搜索探针（程序全站搜索用的是 ac=detail&wd=）
  const useProxy = via === 'proxy' ? PROXY : null;
  const searchRes = await httpGet(withQuery(site.api, `ac=detail&wd=${encodeURIComponent(SEARCH_KEYWORD)}`), {
    proxy: useProxy,
    timeoutMs: useProxy ? PROXY_TIMEOUT : DIRECT_TIMEOUT,
  });
  const searchParsed = parseVod(searchRes.body);

  return {
    ...site,
    alive: true,
    via,
    latency: attempts.find((a) => a.mode === via)?.ms ?? null,
    searchable: searchParsed.ok,
    searchCount: searchParsed.count || 0,
    searchReason: searchParsed.ok ? '' : searchParsed.reason,
    reason: '',
    attempts,
    fingerprint: fingerprint(listResult.names),
    listCount: listResult.count,
    classes: listResult.classes,
    total: listResult.total || 0,
    sample: listResult.names,
  };
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main() {
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(SRC, 'utf-8'));
  const apiSite = raw?.api_site ?? raw;
  const entries = Object.entries(apiSite).map(([key, site]) => ({
    key,
    name: String(site?.name || key),
    api: String(site?.api || ''),
    detail: site?.detail ? String(site.detail) : undefined,
    comment: site?._comment ? String(site._comment) : undefined,
  }));

  console.log(`共 ${entries.length} 条配置，开始探测…`);
  let done = 0;
  const probed = await runPool(entries, CONCURRENCY, async (e) => {
    const r = await probe(e);
    done += 1;
    process.stdout.write(
      `\r[${done}/${entries.length}] ${r.alive ? (r.via === 'direct' ? '直连' : '代理') : '失败'} ${r.key}          `,
    );
    return r;
  });
  process.stdout.write('\n');

  // 1) 完全相同的 API 地址
  const byApi = new Map();
  for (const p of probed) {
    const id = normalizeApi(p.api);
    if (!byApi.has(id)) byApi.set(id, []);
    byApi.get(id).push(p);
  }
  const urlDupes = [];
  for (const [id, group] of byApi) {
    if (group.length > 1) urlDupes.push({ id, keys: group.map((g) => g.key) });
  }

  // 2) 内容相同（首页前几个条目名一致）→ 同一片源的镜像
  const byFp = new Map();
  for (const p of probed) {
    if (!p.alive || !p.fingerprint) continue;
    if (!byFp.has(p.fingerprint)) byFp.set(p.fingerprint, []);
    byFp.get(p.fingerprint).push(p);
  }
  const contentDupes = [];
  for (const [, group] of byFp) {
    if (group.length > 1) {
      contentDupes.push({
        keys: group.map((g) => g.key),
        apis: group.map((g) => g.api),
        sample: group[0].sample,
      });
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: path.resolve(SRC),
    proxy: PROXY,
    total: probed.length,
    alive: probed.filter((p) => p.alive).length,
    aliveDirect: probed.filter((p) => p.via === 'direct').length,
    aliveProxy: probed.filter((p) => p.via === 'proxy').length,
    searchable: probed.filter((p) => p.alive && p.searchable).length,
    urlDuplicates: urlDupes,
    contentDuplicates: contentDupes,
    sites: probed,
  };
  writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(payload, null, 2), 'utf-8');

  const lines = [];
  lines.push(`# 资源站探测报告 ${payload.generatedAt}`);
  lines.push(`总计 ${payload.total}｜存活 ${payload.alive}（直连 ${payload.aliveDirect} / 仅代理 ${payload.aliveProxy}）｜可搜索 ${payload.searchable}`);
  lines.push('');
  lines.push('## 存活站点（按延迟）');
  for (const p of probed.filter((x) => x.alive).sort((a, b) => a.latency - b.latency)) {
    lines.push(
      `${String(p.latency).padStart(5)}ms  ${p.via === 'proxy' ? 'P' : 'D'}  ${p.searchable ? '搜' : '  '}  ${p.key}  ${p.name}  [${p.listCount} 条]`,
    );
  }
  lines.push('');
  lines.push('## 失败站点');
  for (const p of probed.filter((x) => !x.alive)) {
    lines.push(`${p.key}  ${p.name}  ${p.api}  -> ${p.reason}`);
  }
  lines.push('');
  lines.push('## 重复：同一 API 地址');
  for (const d of urlDupes) lines.push(`${d.id}  <- ${d.keys.join(', ')}`);
  lines.push('');
  lines.push('## 重复：同一片源镜像');
  for (const d of contentDupes) lines.push(`${d.keys.join(' / ')}  | ${d.sample.slice(0, 2).join(' · ')}`);
  writeFileSync(path.join(OUT_DIR, 'summary.txt'), lines.join('\n'), 'utf-8');

  console.log(
    `存活 ${payload.alive}/${payload.total}（直连 ${payload.aliveDirect}，仅代理 ${payload.aliveProxy}），可搜索 ${payload.searchable}`,
  );
  console.log(`报告：${path.join(OUT_DIR, 'report.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
