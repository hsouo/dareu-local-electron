// src/server.js —— 本地守护进程：静态托管 webapp + 提供 WebHID 兼容 API（HTTP + SSE）
//
//   GET  /                     webapp/index.html（注入一行 <script src="/hid-shim.js">，源文件零改动）
//   GET  /hid-shim.js          navigator.hid 垫片
//   GET  /api/devices          设备列表（WebHID 形状 + 诊断信息）
//   GET  /api/state            devices + 授权表 + 家族配置 + trace
//   POST /api/open|close       {id}
//   POST /api/send-report      {id, reportId, data(base64), size?}
//   POST /api/send-feature-report {id, reportId, data}
//   POST /api/receive-feature-report {id, reportId} -> {data(base64)}
//   POST /api/authorize|deauthorize {ids[]}
//   POST /api/collections-cache {devices:[...]}      收录 Chrome 抓到的真实 collections
//   POST /api/raw/{write,feature,get-feature}        CLI 原始报文调试
//   GET  /probe.html           无头自检页（requestDevice→open→sendReport→inputreport→close）
//   POST /api/shutdown
//   GET  /api/events           SSE：hello / inputreport / add / remove / trace
//
// 只监听 127.0.0.1。渲染层与守护进程之间只用 HTTP，不引入额外依赖。
// 端口：首选 DAREU_PORT(默认 8082)；被别的程序占了就自动顺延（+1…+40，再不行用临时端口）；
//       如果占着端口的就是本项目的另一个守护进程，则不再起第二个，直接提示复用现有地址。
//       实际端口写进 state/daemon.json，CLI / 测试脚本用 src/port.js 的 discover() 自动找到。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { HidService } = require('./hid-service');
const Port = require('./port.js');

const ROOT = path.resolve(__dirname, '..');
const WEBAPP = path.join(ROOT, 'webapp');
const SHIM = path.join(__dirname, 'shim', 'hid-shim.js');
const OFFLINE = path.join(__dirname, 'shim', 'offline-stub.js');
const LOGIN = path.join(__dirname, 'pages', 'login.html');
const PROBE = path.join(__dirname, 'probe.html');

// 注入标签：先离线短路（必须早于 js/api/api.js），再接管 navigator.hid
const OFFLINE_TAG = '<script src="/offline-stub.js"></script>';
const SHIM_TAG = '<script src="/hid-shim.js"></script>';
// 版权/备案号：原厂把文案放在 language/*.json 的 Copyright / Filings 里，由 index.html:112-113
// 的 #labCopyright / #labFilings 显示（后者还指向 https://beian.miit.gov.cn/）。
// webapp/ 要保持与原厂逐字节一致，所以改动只发生在服务端：
//   ① 语言包出网前把这两个字段抹成空串（DOM 里就永远不会出现文案）
//   ② 再注入一条 CSS 把这两个元素藏掉（防止别处也引用）
const BRAND_KEYS = ['Copyright', 'Filings'];
const BRAND_STYLE = '<style>#labCopyright,#labFilings{display:none!important}</style>';
// 直接在原文上做值替换（不整体 JSON.parse 再 stringify）：除这两个值之外，
// 字节与原厂文件完全一致，也不会因为重复键/顺序问题引入差异。
function stripBrandText(raw) {
  let n = 0;
  const text = raw.replace(/("(?:Copyright|Filings)"\s*:\s*")((?:[^"\\]|\\.)*)(")/g, (m, a, v, c) => { n++; return a + '' + c; });
  return { text, n };
}
const INJECT_BOTH = BRAND_STYLE + '\n    ' + OFFLINE_TAG + '\n    ' + SHIM_TAG + '\n    ';
const INJECT_HTML = BRAND_STYLE + '\n    ' + OFFLINE_TAG + '\n    ';
const INJECT = {
  both: Buffer.byteLength(INJECT_BOTH, 'utf8'),
  html: Buffer.byteLength(INJECT_HTML, 'utf8'),
  shimTag: SHIM_TAG, offlineTag: OFFLINE_TAG, brandStyle: BRAND_STYLE, brandKeys: BRAND_KEYS
};
const MISSING_PAGE = Buffer.from(`<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>还差一步：放置官方前端资源</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1120;color:#e5e7eb;font:15px/1.7 "Microsoft YaHei",system-ui,sans-serif}
 .card{max-width:760px;padding:34px 38px;background:#111827;border:1px solid #1f2937;border-radius:14px}
 h1{margin:0 0 6px;font-size:21px;color:#fff}
 p{margin:10px 0;color:#9ca3af}
 code{background:#1f2937;color:#fbbf24;padding:2px 6px;border-radius:5px;font-size:13px}
 ol{padding-left:22px}li{margin:6px 0}
 .ok{color:#34d399}.warn{color:#f87171}
</style>
<div class="card">
 <h1>守护进程已经在跑，但官方前端还没放进来</h1>
 <p class="ok">HID 通道正常：<code>GET /api/state</code> 有响应（设备枚举、报告收发都可用）。</p>
 <p>本仓库不分发达尔优官方网页驱动的那套静态资源，需要你把自己的那份放到：</p>
 <p><code id="target"></code></p>
 <ol>
  <li>目录下要能直接看到 <code>index.html</code>，以及 <code>js/</code>、<code>pages/</code>、<code>css/</code>、<code>products/</code>、<code>language/</code>、<code>images/</code></li>
  <li>放好后刷新本页即可（守护进程不用重启）</li>
  <li>命令行可以看一眼：<code>node src/cli.js list</code></li>
 </ol>
 <p class="warn">注意：请放官方 <code>web_driver</code> 那一层的内容本身，不要再套一层同名子目录。</p>
</div>
<script>document.getElementById('target').textContent = 'webapp/（项目根目录下）';</script>
`, 'utf8');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8'
};

class Trace {
  constructor(limit = 2000) { this.items = []; this.seq = 0; this.limit = limit; }
  add(kind, msg, extra) {
    const it = { seq: ++this.seq, t: Date.now(), kind, msg, extra };
    this.items.push(it);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    return it;
  }
  since(n) { return this.items.filter(x => x.seq > n); }
}

function createServer(opts = {}) {
  // 注意：opts.port 允许显式 0（随机端口，selftest 用），不能用 || 兜底，否则 0 会变成 8082
  const port = opts.port !== undefined && opts.port !== null
    ? Number(opts.port)
    : Number(process.env.DAREU_PORT || 8082);
  const host = opts.host || '127.0.0.1';
  const trace = new Trace();
  const verbose = !!opts.verbose;
  const log = (...a) => {
    const line = a.join(' ');
    trace.add('log', line);
    if (verbose) console.log('[hid]', line);
  };

  const svc = new HidService({ log, productsDir: path.join(WEBAPP, 'products') });
  svc.refresh();
  svc.startPolling(opts.pollMs || 1500);

  svc.on('add', d => { trace.add('add', `接入 ${d.productName} (${hex4(d.vendorId)}:${hex4(d.productId)})`); broadcast('add', pub(d)); });
  svc.on('remove', d => { trace.add('remove', `拔出 ${d.productName || d.id}`); broadcast('remove', pub(d)); });
  svc.on('inputreport', r => {
    // 高频保护：input report 只在有 SSE 客户端时转发；同时记录摘要
    if (trace.items.length > 1900) trace.add('in', `report ${r.reportId} ${r.data.length}B (id=${r.id})`);
    broadcast('inputreport', { id: r.id, reportId: r.reportId, data: r.data.toString('base64'), usagePage: r.usagePage, usage: r.usage });
  });

  const clients = new Set();
  function broadcast(kind, obj) {
    const body = `event: ${kind}\ndata: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) { try { res.write(body); } catch { /* ignore */ } }
  }
  function hex4(n) { return (n >>> 0).toString(16).toUpperCase().padStart(4, '0'); }
  function pub(d) { return typeof svc.publicDevice === 'function' && d && d.__paths ? svc.publicDevice(d) : d; }

  // ── 请求处理 ──────────────────────────────────────────────────────────
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > 8 << 20) { reject(new Error('body 过大')); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }
  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end(body);
  }

  const routes = {
    'GET /api/devices': () => ({ ok: true, devices: svc.publicList(), authorized: svc.authorizedDevices().map(d => d.id) }),
    'GET /api/all': () => ({ ok: true, devices: svc.allDevices(), authorized: svc.authorizedDevices().map(d => d.id) }),
    'GET /api/state': () => ({
      ok: true,
      service: Port.SERVICE,          // port.js 靠这个标记认出"这是我们自己的守护进程"
      pid: process.pid,
      port: api.port,
      devices: svc.publicList(),
      authorized: svc.authorizedDevices().map(d => d.id),
      hidapi: safeHidapiVersion(),
      node: process.version,
      families: Object.fromEntries(Object.entries(svc.profiles.families).map(([k, v]) => [k, v.label])),
      cachedCollections: Object.keys(svc.collectionCache),
      offline: true,                    // 云端接口由 /offline-stub.js 就地短路
      inject: { both: INJECT.both, html: INJECT.html },
      trace: trace.since(0).slice(-80)
    }),
    'GET /api/trace': (q) => ({ ok: true, trace: trace.since(Number(q.get('since') || 0)) }),
    // 无头自检（tools/verify-app.ps1）把页面走向回灌进 trace，避免依赖 --dump-dom
    'POST /api/event-log': (q, body) => { trace.add('auto', JSON.stringify(body).slice(0, 1200)); return { ok: true }; },
    'POST /api/open': async (q, body) => ({ ok: true, device: pub2(svc.open(body.id)) }),
    'POST /api/close': async (q, body) => { svc.close(body.id); return { ok: true }; },
    'POST /api/authorize': async (q, body) => {
      const changed = svc.authorize(body.ids || []);
      trace.add('auth', `授权 ${changed.length} 台设备`);
      return { ok: true, authorized: svc.authorizedDevices().map(d => d.id) };
    },
    'POST /api/deauthorize': async (q, body) => {
      svc.deauthorize(body.ids || []);
      return { ok: true, authorized: svc.authorizedDevices().map(d => d.id) };
    },
    'POST /api/refresh': () => { svc.refresh(); return { ok: true, devices: svc.publicList() }; },
    'POST /api/send-report': async (q, body) => {
      const r = svc.sendReport(body.id, body.reportId | 0, Buffer.from(body.data || '', 'base64'), body.size);
      return { ok: true, ...r };
    },
    'POST /api/send-feature-report': async (q, body) => {
      const r = svc.sendFeatureReport(body.id, body.reportId | 0, Buffer.from(body.data || '', 'base64'), body.size);
      return { ok: true, ...r };
    },
    'POST /api/receive-feature-report': async (q, body) => {
      const r = svc.receiveFeatureReport(body.id, body.reportId | 0);
      return { ok: true, data: r.data.toString('base64'), length: r.length, path: r.path };
    },
    'POST /api/collections-cache': async (q, body) => {
      const list = body.devices || [];
      svc.saveCollectionCache(list);
      trace.add('cache', `导入 Chrome collections ${list.length} 条`);
      return { ok: true, devices: svc.publicList() };
    },
    'POST /api/raw/write': async (q, body) => {
      const buf = Buffer.from(body.data || '', 'base64');
      const h = handleByPath(svc, body.path);
      if (!h) throw new Error('未打开的 path: ' + body.path);
      h.hid.write(buf);
      return { ok: true, bytes: buf.length };
    },
    'POST /api/raw/feature': async (q, body) => {
      const h = handleByPath(svc, body.path);
      if (!h) throw new Error('未打开的 path: ' + body.path);
      h.hid.sendFeatureReport(Buffer.from(body.data || '', 'base64'));
      return { ok: true };
    },
    'POST /api/raw/get-feature': async (q, body) => {
      const h = handleByPath(svc, body.path);
      if (!h) throw new Error('未打开的 path: ' + body.path);
      const got = Buffer.from(h.hid.getFeatureReport(body.reportId | 0, body.length | 0));
      return { ok: true, data: got.toString('base64') };
    },
    'POST /api/raw/inject': async (q, body) => ({ ok: true, ...svc.injectReport(body.id, body.reportId | 0, body.data || '') }),
    'POST /api/shutdown': () => { setTimeout(() => process.exit(0), 50); Port.clearPortFile(api.port); return { ok: true }; }
  };

  function pub2(d) { return d; }
  function handleByPath(s, p) {
    for (const dev of s.devices.values()) for (const h of dev.__paths.values()) if (h.info.path === p && h.hid) return h;
    return null;
  }
  function safeHidapiVersion() { try { return require('node-hid').getHidapiVersion(); } catch { return '?'; } }

  // ── 静态文件 ──────────────────────────────────────────────────────────
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (rel === '' ) rel = 'index.html';
    if (rel === 'hid-shim.js') return sendFile(res, SHIM, 'text/javascript; charset=utf-8', '');
    if (rel === 'offline-stub.js') return sendFile(res, OFFLINE, 'text/javascript; charset=utf-8', '');
    if (rel === 'probe.html') return sendFile(res, PROBE, 'text/html; charset=utf-8', '');

    const abs = path.join(WEBAPP, rel);
    if (!abs.startsWith(WEBAPP + path.sep) && abs !== path.join(WEBAPP, 'index.html')) {
      res.writeHead(403).end('forbidden'); return;
    }
    // 官方前端资源不随本仓库分发；没放到位时给一页明确的指引，而不是满屏 404
    if (!fs.existsSync(path.join(WEBAPP, 'index.html'))) {
      // login.html 是我们的本地桩（api.js 401 会跳它），即使在缺资源状态下也要能打开
      if (rel === 'login.html') return sendFile(res, LOGIN, 'text/html; charset=utf-8', '');
      if (rel === 'index.html' || rel.endsWith('.html') || rel === 'favicon.ico') return sendBuf(res, MISSING_PAGE, 'text/html; charset=utf-8');
      trace.add('404', rel.split('?')[0]);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('webapp/ 还没放进来，见 http://127.0.0.1:' + api.port + '/');
      return;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      // webapp 缺 login.html：api.js 401 会跳 /login.html，本地给一页说明，别让它 404
      if (rel === 'login.html') return sendFile(res, LOGIN, 'text/html; charset=utf-8', '');
      trace.add('404', rel.split('?')[0]);
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const base = path.basename(abs).toLowerCase();
    if (base === 'index.html' && abs === path.join(WEBAPP, 'index.html')) return sendFile(res, abs, MIME['.html'], INJECT_BOTH);
    if (base.endsWith('.html')) return sendFile(res, abs, MIME['.html'], INJECT_HTML);
    // 语言包里的版权/备案文案在发出前抹掉（磁盘上的 webapp 仍然与原厂一致）
    if (/^language\/[\w-]+\.json$/i.test(rel)) {
      try {
        const { text, n } = stripBrandText(fs.readFileSync(abs, 'utf8'));
        if (n) {
          trace.add('brand', `已抹掉 ${rel} 里的 ${n} 处版权/备案文案`);
          return sendBuf(res, Buffer.from(text, 'utf8'), 'application/json; charset=utf-8');
        }
      } catch { /* 读不动就原样发 */ }
    }
    sendFile(res, abs, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', '');
  }

  function sendBuf(res, data, type) {
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': data.length,
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  }

  function sendFile(res, abs, type, inject) {
    let data = fs.readFileSync(abs);
    if (inject) {
      let html = data.toString('utf8');
      const marker = inject.includes('hid-shim.js') ? 'hid-shim.js' : 'offline-stub.js';
      if (!html.includes(marker)) {
        const i = html.search(/<script\b/i);
        html = i < 0 ? html.replace(/<\/head>/i, inject + '</head>') : html.slice(0, i) + inject + html.slice(i);
        data = Buffer.from(html, 'utf8');
      }
    }
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': data.length,
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${host}:${port}`);
    const key = req.method + ' ' + u.pathname;
    if (req.method === 'OPTIONS') { json(res, 200, {}); return; }

    if (u.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*'
      });
      res.write('retry: 800\n');
      clients.add(res);
      broadcast('hello', { devices: svc.publicList(), authorized: svc.authorizedDevices().map(d => d.id) });
      const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch { /* ignore */ } }, 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    if (u.pathname.startsWith('/api/')) {
      const fn = routes[key];
      if (u.pathname !== '/api/events') trace.add('api', key + (fn ? '' : ' → 无路由'));
      if (!fn) { json(res, 404, { ok: false, error: 'no route ' + key }); return; }
      try {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const out = await fn(u.searchParams, body);
        json(res, 200, out);
      } catch (e) {
        trace.add('err', `${key}: ${e.message}`);
        json(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    serveStatic(req, res, u.pathname);
  });

  const api = {
    server, svc, trace, port, host, log, INJECT,
    OFFLINE_STUB: OFFLINE, LOGIN_PAGE: LOGIN,
    /**
     * 开始监听。端口被占会自动顺延（见 src/port.js）；
     * 如果占用者就是另一个本进程守护进程，抛 AlreadyRunningError（code=DAREU_ALREADY_RUNNING）。
     */
    start: async () => {
      const r = await Port.scanListen(server, { host, port, range: opts.portRange, autoPort: opts.autoPort });
      api.port = r.port;
      api.note = r.note;
      return { port: r.port, host, note: r.note, moved: !!r.moved };
    },
    close: () => new Promise((resolve) => { try { svc.dispose(); } catch (e) {} Port.clearPortFile(api.port); server.close(resolve); })
  };
  return api;
}

if (require.main === module) {
  const opts = {
    port: Number(process.env.DAREU_PORT || 8082),
    verbose: process.argv.includes('--verbose') || process.argv.includes('-v')
  };
  const { svc, server, start } = createServer(opts);
  let boundPort;                       // start() 成功后记录，退出时清掉 state/daemon.json
  const wantOpen = process.argv.includes('--open') ? 'default'
    : process.argv.includes('--edge-app') ? 'edge-app' : null;
  // 手动指定了 DAREU_PORT 就是要起第二个实例：提醒一句（两个进程会打开同一个 HID 设备），
  // 不指定端口的常规路径不会走到这里——那种情况 scanListen 会直接识别并复用现成的。
  const warnSecond = process.env.DAREU_PORT
    ? Port.discover().then((f) => {
        if (f && f.port !== opts.port) console.log(`提醒：已有守护进程在 http://127.0.0.1:${f.port}/（pid=${f.info.pid}），`
          + `你现在起的是第二个实例，两边会打开同一个 HID 设备；想复用它就别带 DAREU_PORT。`);
      })
    : Promise.resolve();
  warnSecond.then(() => start()).then(({ host, port, note }) => {
    boundPort = port;
    console.log(`\n达尔优本地驱动守护进程已启动`);
    console.log(`  应用地址: http://${host}:${port}/`);
    if (note) console.log(`  端口提示: ${note}`);
    console.log(`  hidapi:   ${safeVersion()}`);
    const devs = svc.publicList();
    console.log(`  已识别达尔优设备 ${devs.length} 台:`);
    for (const d of devs) {
      console.log(`    - ${d.productName}  ${d.vendorId.toString(16)}:${d.productId.toString(16)}  ` +
        `family=${d.family || '未知'} model=${d.model || '?'} fwType=${d.fwType} collections=${d.collections.length}` +
        `${d.authorized ? '  [已授权]' : ''}`);
    }
    if (!devs.length) console.log('    (未发现 VID 0x260D 的设备，插入接收器/鼠标后会自动出现)');
    console.log(`\n  CLI 会自动通过 state/daemon.json 找到这个端口，不用手动告诉它。\n`);
    console.log(`  Ctrl+C 退出\n`);
    Port.writePortFile({
      service: Port.SERVICE, host, port, url: `http://${host}:${port}/`,
      pid: process.pid, startedAt: new Date().toISOString(), hidapi: safeVersion()
    });
    svc.startPolling();
    if (wantOpen) openIn(`http://${host}:${port}/`, wantOpen);
  }).catch(async (e) => {
    if (e instanceof Port.AlreadyRunningError) {
      // 已经有一个守护进程在跑：起第二个会和它抢同一个 HID 设备，所以直接复用现成的
      const url = `http://127.0.0.1:${e.port}/`;
      const who = e.info ? `（pid=${e.info.pid}，设备 ${e.info.devices ? e.info.devices.length : '?'} 台，hidapi ${e.info.hidapi}）` : '';
      console.log(`已有守护进程在运行，直接复用： ${url} ${who}`);
      console.log(`  要重启： npm run stop（= POST /api/shutdown）；要换端口： DAREU_PORT=8090 npm run open`);
      if (wantOpen) openIn(url, wantOpen);
      try { svc.dispose(); } catch (err) {}
      process.exit(0);
    }
    console.error('启动失败: ' + e.message);
    try { svc.dispose(); } catch (err) {}
    process.exit(1);
  });
  const stop = () => { Port.clearPortFile(boundPort); svc.dispose(); server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
function safeVersion() { try { return require('node-hid').getHidapiVersion(); } catch { return '?'; } }

/**
 * 打开界面。--edge-app 用 Edge 的 --app 模式（无地址栏的独立窗口 + 项目内独立 profile），
 * 这是没装 Electron 时最接近桌面程序的形态；WebHID 由 /hid-shim.js 接管，所以浏览器差异不影响协议。
 */
function openIn(url, mode) {
  const { spawn } = require('node:child_process');
  const opt = { detached: true, stdio: 'ignore' };
  try {
    if (process.platform === 'win32') {
      if (mode === 'edge-app') {
        const cands = [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge Core\\Application\\msedge.exe'
        ];
        const edge = cands.find((p) => fs.existsSync(p));
        if (!edge) { console.log('没找到 msedge.exe，请手动打开 ' + url); return; }
        spawn(edge, ['--app=' + url, '--user-data-dir=' + path.join(ROOT, 'state', 'edge-app-profile'), '--no-first-run', '--no-default-browser-check'], opt).unref();
        console.log('已用 Edge --app 打开：' + url);
        return;
      }
      spawn('cmd', ['/c', 'start', '', url], opt).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], opt).unref();
    } else {
      spawn('xdg-open', [url], opt).unref();
    }
    console.log('已在默认浏览器打开：' + url);
  } catch (e) {
    console.log('自动打开浏览器失败（' + e.message + '），请手动访问 ' + url);
  }
}

module.exports = { createServer };
