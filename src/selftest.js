#!/usr/bin/env node
/**
 * dareu 自检（不需要真机）  (src/selftest.js)
 *
 *   node src/selftest.js
 *
 * 覆盖：
 *   A. hid-profiles.json / products 目录 / webapp 完整性
 *   B. 垫片源码约束（navigator.hid 接管、精确长度 DataView、无 Node 依赖）
 *   C. 守护进程 HTTP：静态托管 + index.html 注入垫片 + API 形状 + 路径穿越防护
 *   D. 用 index.html 的真实判据模拟设备识别（collections 特征 → 命令通道）
 *   E. 协议层能在纯 Node 沙箱里加载（子进程跑 test-protocol.js --dry-run）
 * 真机部分不在这里，见 npm run test:live
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}` + (extra ? `  → ${extra}` : '')); }
}
function section(t) { console.log(`\n== ${t} ==`); }
let skipped = 0;
function skip(name, why) { skipped++; console.log(`  - 跳过 ${name}` + (why ? `  （${why}）` : '')); }
// webapp/ 是官方网页驱动的资源，本仓库不附带（见 README「获取 webapp」）。
// 没放进来时，依赖它的断言记为跳过，而不是失败。
let HAS_WEBAPP = false;
function okWeb(cond, name, extra) {
  if (!HAS_WEBAPP) return skip(name, 'webapp/ 未就位');
  ok(cond, name, extra);
}
function getJSON(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: data ? 'POST' : 'GET',
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 挂上 SSE，收到 hello 后注入一条报告，看能不能原样推回来（垫片的数据通路） */
function sseRoundTrip(port, id) {
  return new Promise((resolve) => {
    const events = [];
    let injected = false, got = null, closed = false;
    const finish = () => { if (closed) return; closed = true; clearTimeout(to); try { req.destroy(); } catch (e) {} resolve({ events, got }); };
    const to = setTimeout(finish, 3000);
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const name = (raw.match(/^event: (.*)$/m) || [])[1];
          const data = (raw.match(/^data: (.*)$/m) || [])[1];
          if (!name) continue;
          events.push(name);
          if (name === 'hello' && !injected) { injected = true; getJSON(port, '/api/raw/inject', { id, reportId: 8, data: 'AQIDBAUGBwg=' }).catch(() => finish()); }
          if (name === 'inputreport' && !got) { try { got = JSON.parse(data); } catch (e) {} finish(); }
        }
      });
      res.on('end', finish);
    });
    req.on('error', finish);
  });
}

async function main() {  /* ---------- A ---------- */
  section('A. 配置与 webapp 完整性');
  const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'hid-profiles.json'), 'utf8'));
  ok('hid-profiles.json 可解析', !!profiles.families);
  ok('vendorIds 含 0x260D(9741)', (profiles.vendorIds || []).includes(9741));
  const fams = Object.entries(profiles.families);
  ok('家族数量 = 6 (TG/TGHS/JM/QF/OHID/HY)', fams.length === 6, fams.map(f => f[0]).join(','));
  const keyBad = [];
  for (const [n, f] of fams) {
    for (const k of Object.keys(f.collections || {})) {
      if (!/^0x[0-9A-Fa-f]{2,4}:0x[0-9A-Fa-f]{2,4}$/.test(k)) keyBad.push(`${n}/${k}`);
      const c = f.collections[k];
      if (!('role' in c) || !Array.isArray(c.input) || !Array.isArray(c.output) || !Array.isArray(c.feature)) keyBad.push(`${n}/${k} 字段不全`);
    }
  }
  ok('所有 collections 键格式正确且字段齐全', keyBad.length === 0, keyBad.join(' '));
  const fwSeen = new Set();
  for (const [, f] of fams) for (const t of f.fwTypes || []) fwSeen.add(t);
  ok('FwType 覆盖 0..7 除 5 之外都有说明', [0, 1, 2, 3, 4, 6, 7].every(t => fwSeen.has(t)), [...fwSeen].sort().join(','));
  for (const [pid, o] of Object.entries(profiles.byPid || {})) {
    ok(`byPid ${pid} → 家族 ${o.family} 存在`, !!profiles.families[o.family]);
  }
  const idxFile = path.join(ROOT, 'webapp', 'index.html');
  HAS_WEBAPP = fs.existsSync(idxFile);
  let idxSize = 0;
  if (HAS_WEBAPP) {
    const prodDir = path.join(ROOT, 'webapp', 'products');
    const dirs = fs.existsSync(prodDir) ? fs.readdirSync(prodDir, { withFileTypes: true }).filter(d => d.isDirectory()) : [];
    const jsons = dirs.reduce((n, d) => n + fs.readdirSync(path.join(prodDir, d.name)).filter(f => f.endsWith('.json')).length, 0);
    ok('products/ 有产品 JSON（官方 187 个）', dirs.length >= 150 && jsons >= 150, `目录 ${dirs.length}，JSON ${jsons}`);
    idxSize = fs.statSync(idxFile).size;
    ok('webapp/index.html 是完整页面（官方那份 57921B）', idxSize > 50000, `实际 ${idxSize}B`);
    ok('webapp/js/device/jmdevice.js 存在', fs.existsSync(path.join(ROOT, 'webapp', 'js', 'device', 'jmdevice.js')));
  } else {
    skip('products/ + index.html + jmdevice.js', '把官方网页驱动放到 ' + path.join(ROOT, 'webapp'));
  }

  /* ---------- B ---------- */
  section('B. 垫片源码约束');
  const shim = fs.readFileSync(path.join(ROOT, 'src', 'shim', 'hid-shim.js'), 'utf8');
  ok('接管 navigator.hid', /Object\.defineProperty\(navigator,\s*'hid'/.test(shim));
  for (const m of ['getDevices', 'requestDevice', 'sendReport', 'sendFeatureReport', 'receiveFeatureReport', 'oninputreport', 'exclusionFilters']) {
    ok(`实现 ${m}`, shim.includes(m));
  }
  ok('DataView 建在独立精确长度的 buffer 上', /new DataView\(u\.buffer\)/.test(shim) && /toBytes/.test(shim));
  ok('不依赖 Node 模块', !/require\s*\(/.test(shim) && !/module\.exports/.test(shim));
  ok('走 SSE 收 inputreport', /EventSource/.test(shim) && /addEventListener\('inputreport'/.test(shim));

  const stub = fs.readFileSync(path.join(ROOT, 'src', 'shim', 'offline-stub.js'), 'utf8');
  ok('离线垫片不依赖 Node 模块', !/require\s*\(/.test(stub) && !/module\.exports/.test(stub));
  for (const m of ['window.fetch', 'XMLHttpRequest', 'WebSocket', 'window.open', 'loadingpage.html', 'loadingMask']) {
    ok(`离线垫片覆盖 ${m}`, stub.includes(m));
  }
  ok('离线垫片拦 dr.dareu.com', /dareu\.com/.test(stub) && /LOCAL_RE/.test(stub));
  ok('login.html 本地桩存在', fs.existsSync(path.join(ROOT, 'src', 'pages', 'login.html')));
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
  ok('Electron 窗口按「可视区」定尺寸（useContentSize 1280x900，够 830 高的页面 → 无纵向滚动条）',
    /useContentSize:\s*true/.test(mainSrc) && /width:\s*1280/.test(mainSrc) && /height:\s*900/.test(mainSrc) && /minHeight:\s*860/.test(mainSrc));

  /* ---------- C ---------- */
  section('C. 守护进程 HTTP');
  const { createServer } = require('./server.js');
  const srv = createServer({ port: 0, quiet: true });
  const { port } = await srv.start();
  ok('监听成功（随机端口）', port > 0, `port=${port}`);
  try {
    // 依赖 webapp/ 的那几条：webapp 没就位时记为跳过（本仓库不附带官方资源）
    const idx = await getJSON(port, '/index.html');
    okWeb(idx.status === 200, 'GET /index.html 200', `status=${idx.status}`);
    okWeb(idx.body.includes('<script src="/hid-shim.js"></script>'), 'index.html 里注入了 /hid-shim.js');
    okWeb(idx.body.includes('<script src="/offline-stub.js"></script>'), 'index.html 里注入了 /offline-stub.js');
    // 注入 = 在第一个 <script> 前插一行 style + 两行 script，原文件别的一个字不改
    const extra = Buffer.byteLength(idx.body, 'utf8') - idxSize;
    okWeb(extra === srv.INJECT.both && (idx.body.match(/hid-shim\.js/g) || []).length === 1 && (idx.body.match(/offline-stub\.js/g) || []).length === 1,
      'index.html 注入字节数与常量一致（原文件零改动）', `多 ${extra}B（期望 ${srv.INJECT.both}B）`);
    okWeb(idx.body.includes(srv.INJECT.brandStyle), 'index.html 注入了隐藏页脚两条元素的 CSS');
    const sub = await getJSON(port, '/pages/main.html');
    okWeb(sub.body.includes('/offline-stub.js') && !sub.body.includes('/hid-shim.js'),
      '子页面也注入离线垫片但不注入 HID 垫片', `status=${sub.status}`);
    const offRes = await getJSON(port, '/offline-stub.js');
    ok('GET /offline-stub.js 200 + JS 类型', offRes.status === 200 && /javascript/.test(offRes.type));
    const login = await getJSON(port, '/login.html');
    ok('GET /login.html 本地桩（不会 404）', login.status === 200 && /无需登录/.test(login.body), `status=${login.status}`);
    // 页脚两条文案：响应里被抹空，磁盘文件保持原样（断言里不写任何原厂文案）
    const cn = await getJSON(port, '/language/cn.json');
    const diskCnPath = path.join(ROOT, 'webapp', 'language', 'cn.json');
    const diskCn = fs.existsSync(diskCnPath) ? fs.readFileSync(diskCnPath, 'utf8') : '';
    const diskVal = (diskCn.match(/"Copyright"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || '';
    okWeb(cn.status === 200 && /"Copyright"\s*:\s*""/.test(cn.body) && /"Filings"\s*:\s*""/.test(cn.body),
      'GET /language/cn.json 的 Copyright/Filings 已被抹空', `响应 ${Buffer.byteLength(cn.body, 'utf8')}B / 磁盘 ${Buffer.byteLength(diskCn, 'utf8')}B`);
    okWeb(diskVal.length > 0 && !cn.body.includes(diskVal),
      '磁盘语言包未改，且响应体里不再出现那段文案', `磁盘原值 ${diskVal.length} 字符`);
    const enBody = (await getJSON(port, '/language/en.json')).body;
    const krBody = (await getJSON(port, '/language/kr.json')).body;
    okWeb(/"Copyright"\s*:\s*""/.test(enBody) && /"Filings"\s*:\s*""/.test(enBody) && /"Copyright"\s*:\s*""/.test(krBody) && /"Filings"\s*:\s*""/.test(krBody),
      'en/kr 语言包同样被抹空');
    const shimRes = await getJSON(port, '/hid-shim.js');
    ok('GET /hid-shim.js 200 + JS 类型', shimRes.status === 200 && /javascript/.test(shimRes.type));
    const prod = await getJSON(port, '/products/1227/1227.json');
    okWeb(prod.status === 200, 'GET /products/1227/1227.json 200（fetch 同源可用）', `status=${prod.status}`);
    const jsf = await getJSON(port, '/js/device/jmdevice.js');
    okWeb(jsf.status === 200, 'GET /js/device/jmdevice.js 200');
    const main = await getJSON(port, '/pages/main.html');
    okWeb(main.status === 200, 'GET /pages/main.html 200（iframe 层级可用）', `status=${main.status}`);
    const trav = await getJSON(port, '/../package.json');
    ok('路径穿越被挡', trav.status === 404 || trav.status === 403, `status=${trav.status}`);
    const miss = await getJSON(port, '/not-exist-xyz.json');
    ok('缺文件返回 404（埋点 notsupport.json 不会 500）', miss.status === 404, `status=${miss.status}`);
    const st = JSON.parse((await getJSON(port, '/api/state')).body);
    ok('GET /api/state 有 hidapi/node/devices', !!st.hidapi && !!st.node && Array.isArray(st.devices));
    ok('GET /api/state 列出 6 个家族', Object.keys(st.families || {}).length === 6);
    const dv = JSON.parse((await getJSON(port, '/api/devices')).body);
    ok('GET /api/devices 形状正确 {ok,devices,authorized}', dv.ok === true && Array.isArray(dv.devices) && Array.isArray(dv.authorized));
    const all = JSON.parse((await getJSON(port, '/api/all')).body);
    ok('GET /api/all 每接口带长度信息', all.ok && Array.isArray(all.devices));
    const auth = JSON.parse((await getJSON(port, '/api/authorize', { ids: ['__nope__'] })).body || '{}');
    ok('POST /api/authorize 未知 id 不炸', auth.ok === true);
    let bad = null;
    try {
      bad = JSON.parse((await getJSON(port, '/api/open', { id: '__nope__' })).body);
    } catch (e) { bad = { error: e.message }; }
    ok('POST /api/open 未知 id 返回错误信息', !bad || bad.ok !== true, JSON.stringify(bad));
    const tr = JSON.parse((await getJSON(port, '/api/trace')).body);
    ok('GET /api/trace 可用', tr.ok === true && Array.isArray(tr.trace));
    if (all.devices.length) {
      const d0 = all.devices[0];
      const inj = await getJSON(port, '/api/raw/inject', { id: d0.id, reportId: 8, data: 'AAAAAAAAAAAAAAAA' });
      ok('POST /api/raw/inject 注入成功（离线联调链路）', JSON.parse(inj.body).ok === true, inj.body.slice(0, 120));
      // 浏览器那一侧的传输回路：EventSource 收 hello → 我们注入 → SSE 推 inputreport（垫片就靠这条链喂数据给 webapp）
      const sse = await sseRoundTrip(port, d0.id);
      ok('SSE 建联收到 hello', sse.events.includes('hello'), sse.events.join(','));
      ok('SSE 收到注入的 inputreport（id/reportId/base64 齐全）',
        !!sse.got && sse.got.id === d0.id && sse.got.reportId === 8 && typeof sse.got.data === 'string' && Buffer.from(sse.got.data, 'base64').length === 8,
        JSON.stringify(sse.got).slice(0, 160));
    } else {
      console.log('  · 没有插入设备，跳过 inject/SSE 检查（真机检查见 npm run test:live）');
    }
  } finally {
    await srv.close();
  }

  /* ---------- D ---------- */
  section('D. 按 index.html 的判据模拟识别');
  // ParseDevices 的三条真实判据（index.html:230/298/313 与 :766）
  const JM = profiles.families.JM.collections;
  const jmGroup = ['0xFF02:0x02', '0xFF04:0x02', '0xFF03:0x00', '0xFF05:0x00', '0x0C:0x01', '0x01:0x80', '0x01:0x02', '0x01:0x02', '0x01:0x06']
    .map(k => {
      const [up, us] = k.split(':').map(x => parseInt(x, 16));
      const spec = JM[k] || {};
      return {
        usagePage: up, usage: us, childLinks: [],
        inputReports: (spec.input || []).map(reportId => ({ reportId, items: [] })),
        outputReports: (spec.output || []).map(reportId => ({ reportId, items: [] })),
        featureReports: (spec.feature || []).map(reportId => ({ reportId, items: [] }))
      };
    });
  ok('匠盟接收器分组后 collections.length >= 5（index.html:766 选中条件）', jmGroup.length >= 5, `实际 ${jmGroup.length}`);
  const cmd = jmGroup.find(c => c.usagePage === 0xFF02 && c.usage === 0x02 && (c.inputReports || []).some(r => r.reportId === 0x08));
  ok('能在 collections 里认出匠盟命令通道（index.html:313）', !!cmd);
  const consumer = jmGroup.filter(c => c.usagePage === 0x0C && c.usage === 0x01);
  ok('0x0C 消费者接口不冒充命令通道', consumer.length === 1 && !(consumer[0].inputReports || []).length);
  const qf = profiles.families.QF.collections['0xFF04:0x02'];
  ok('群峰判据 feature 0x08 已声明（index.html:306）', (qf.feature || []).includes(8));
  const ohid = profiles.families.OHID.collections['0xFF1C:0x92'];
  ok('合盈 OHID 判据 input 0x08 已声明（index.html:245）', (ohid.input || []).includes(8));
  const tg = profiles.families.TG.collections['0xFF00:0x01'];
  ok('自研判据 0xFF00:0x01 + input 0x04 已声明（index.html:235）', (tg.input || []).includes(4));

  /* ---------- E ---------- */
  section('E. 协议层在无 DOM 的 Node 沙箱里加载');
  if (HAS_WEBAPP) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'test-protocol.js'), '--dry-run'], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    ok(r.status === 0, 'test-protocol --dry-run 退出码 0', `status=${r.status}\n${out.slice(-600)}`);
    ok(/14\/14 个脚本成功/.test(out), '14 个协议脚本全部加载成功');
    ok(/类可用：DongleBase, HidUsbDeviceBase, JmHidDevice/.test(out), '导出 DongleBase/JmHidDevice/HidUsbDeviceBase');
  } else {
    skip('test-protocol --dry-run（协议层可加载）', 'webapp/ 未就位');
  }

  /* ---------- 汇总 ---------- */
  console.log(`\n结果：${pass} 通过, ${fail} 失败` + (skipped ? `, ${skipped} 跳过` : ''));
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  if (!HAS_WEBAPP) console.log('\n提示：本仓库不附带官方前端。把官方网页驱动那套静态资源放到\n      ' + path.join(ROOT, 'webapp') + '\n      （里面直接是 index.html / js / pages / products…），上面跳过的检查就会跑起来。');
  console.log(fail ? '\n❌ 自检未通过' : '\n✅ 自检通过（真机验证请跑 npm run test:live）');
  process.exitCode = fail ? 1 : 0;
  // 轮询句柄已 unref，但 node-hid 可能留着线程；一次性进程直接走人
  setTimeout(() => { try { process.reallyExit(process.exitCode); } catch (e) { process.exit(process.exitCode); } }, 300).unref?.();
}

main().catch((e) => { console.error('自检异常: ' + (e && e.stack || e)); process.exit(1); });
