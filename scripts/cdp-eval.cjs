// 通用 CDP 执行器：在 dev Electron 主窗口里执行一段 JS 并返回结果
// 用法: node cdp-eval.cjs "<expression>" [--pip]  （--pip 选画中画窗口）
const http = require('http');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9333, path }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(JSON.parse(buf)));
      })
      .on('error', reject);
  });
}

async function main() {
  const expr = process.argv[2];
  const wantPip = process.argv.includes('--pip');
  const targets = await getJson('/json/list');
  const pages = targets.filter((t) => t.type === 'page');
  const page = pages.find((t) => (wantPip ? t.url.includes('pip=1') : !t.url.includes('pip=1')));
  if (!page) {
    console.log('NO_TARGET', JSON.stringify(pages.map((t) => t.url)));
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const id = 1;
  // 先把窗口带到前台，避免后台页面定时器被节流导致 eval 卡死
  ws.send(JSON.stringify({ id: 0, method: 'Page.bringToFront' }));
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }),
  );
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== id) return;
    if (msg.result?.exceptionDetails) {
      console.log('EXCEPTION:', JSON.stringify(msg.result.exceptionDetails, null, 2));
    } else {
      console.log(JSON.stringify(msg.result?.result?.value, null, 2));
    }
    ws.close();
    process.exit(0);
  };
  setTimeout(() => {
    console.log('TIMEOUT');
    process.exit(1);
  }, 30000);
}

main().catch((e) => {
  console.log('ERR', e.message);
  process.exit(1);
});
