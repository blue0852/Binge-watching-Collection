import fetch from 'node-fetch';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
const entries = Object.entries(config.api_site);
const TIMEOUT_MS = 8000;

function buildListUrl(api) {
  return api.includes('?') ? `${api}&ac=list&pg=1` : `${api}?ac=list&pg=1`;
}

async function checkSite(key, site) {
  const urls = [buildListUrl(site.api)];
  if (site.api.startsWith('http://')) {
    urls.push(buildListUrl(site.api.replace(/^http:\/\//, 'https://')));
  }

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.code !== undefined && data.code !== 1) continue;
      if (!data.list && !data.class) continue;
      return { key, ok: true, name: site.name };
    } catch {
      // try next url
    }
  }
  return { key, ok: false, name: site.name };
}

async function main() {
  const results = [];
  const batchSize = 10;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(([k, s]) => checkSite(k, s)));
    results.push(...batchResults);
    console.error(`checked ${Math.min(i + batchSize, entries.length)}/${entries.length}`);
  }

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const outPath = path.join(root, 'tmp-health.json');
  writeFileSync(outPath, JSON.stringify({ ok, bad }, null, 2));

  const newApiSite = {};
  for (const { key } of ok) {
    newApiSite[key] = config.api_site[key];
  }

  writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ ...config, api_site: newApiSite }, null, 2) + '\n',
  );

  console.log(JSON.stringify({ kept: ok.length, removed: bad.length, removedKeys: bad.map((b) => b.key) }));
}

main();
