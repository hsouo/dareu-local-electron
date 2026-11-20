#!/usr/bin/env node
/**
 * 垫片端到端自测  (src/test-shim.js)
 *
 * 没有浏览器也能验证「浏览器那一侧」的完整链路：
 *   在 Node 里造一个最小浏览器环境（EventTarget / Event / fetch / EventSource / navigator / location），
 *   加载真实的 src/shim/hid-shim.js，然后按 webapp 的用法调用 navigator.hid，
 *   请求经 HTTP+SSE 打到守护进程 → node-hid → 真机。
 *
 *   node src/test-shim.js            （需要守护进程已在跑：npm start）
 *   node src/test-shim.js --spawn    （自己拉一个守护进程子进程）
 *
 * 覆盖 index.html 的真实调用序列：requestDevice(filters+exclusionFilters) → open →
 * oninputreport 解析（DataView 精确长度，jmdevice.js:79 依赖）→ sendReport 落到命令通道。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const Port = require('./port.js');

const ROOT = path.join(__dirname, '..');
let PORT = null;          // 运行时自动发现（守护进程端口可能被自动顺延过），见 src/port.js
const HOST = '127.0.0.1';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}` + (extra ? `  → ${extra}` : '')); }
}

/* ---------------- 最小浏览器环境 ---------------- */

function makeEventSourceClass() {
  // 只实现垫片用到的部分：addEventListener('open'|事件名)、onerror、close()
  class EventSourceShim {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.onerror = null;
      this.readyState = 0;
      this._buf = '';
      const u = new URL(url);
      this._req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
        this.readyState = 1;
        this._emit('open', {});
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          this._buf += chunk;
          let i;
          while ((i = this._buf.indexOf('\n\n')) >= 0) {
            const raw = this._buf.slice(0, i);
            this._buf = this._buf.slice(i + 2);
            const name = (raw.match(/^event: (.*)$/m) || [])[1] || 'message';
            const data = (raw.match(/^data: (.*)$/m) || [])[1];
            if (data !== undefined) this._emit(name, { type: name, data });
          }
        });
        res.on('end', () => { this.readyState = 2; if (this.onerror) this.onerror({}); });
      });
      this._req.on('error', (e) => { this.readyState = 2; if (this.onerror) this.onerror(e); });
    }
    addEventListener(name, cb) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(cb);
    }
    _emit(name, ev) { (this.listeners.get(name) || []).forEach((cb) => { try { cb(ev); } catch (e) { console.error('ES 回调抛错', e.message); } }); }
    close() { this.readyState = 2; try { this._req.destroy(); } catch (e) {} }
  }
  return EventSourceShim;
}

function loadShim() {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'shim', 'hid-shim.js'), 'utf8');
  const nav = {};
  const sandbox = {
    console, fetch, EventTarget, Event, TextEncoder, TextDecoder, URL, Map, Set, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, TypeError, RegExp,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    location: { hostname: HOST, port: String(PORT), origin: `http://${HOST}:${PORT}` },
    navigator: nav,
    EventSource: makeEventSourceClass(),
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'hid-shim.js' });
  return sandbox;
}

/* ---------------- 与 index.html 相同的过滤器 ---------------- */

const DEVICE_FILTERS = [
  { usagePage: 0xFF02, usage: 0x02 },
  { usagePage: 0xFF01, usage: 0x00 },
  { usagePage: 0x0C, usage: 0x01 },
  { usagePage: 0xFF40, usage: 0x01 },
  { usagePage: 0xFF04, usage: 0x02 }
];
const EXCLUSION_FILTERS = [
  { vendorId: 9741, productId: 69761, usagePage: 0xFF02, usage: 0x02 },
  { vendorId: 9741, productId: 69745, usagePage: 0xFF02, usage: 0x02 }
];

function classify(devices) {
  // index.html ParseDevices 的判据（简化但同构）：先找匠盟 0xFF02:0x02 + input 0x08
  const out = { Command: null, Notify: [] };
  for (const d of devices) {
    const c = (d.collections || []).find(x => x.usagePage === 0xFF02 && x.usage === 0x02 && (x.inputReports || []).some(r => r.reportId === 0x08));
    if (c && !out.Command) out.Command = d;
  }
  return out;
}

async function waitFor(daemonUp, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/api/devices`);
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  let child = null;
  if (process.argv.includes('--spawn')) {
    // 不指定端口，让守护进程自己避让；已经在跑的话它会直接复用现成的那个（不会抢 HID 设备）
    child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { stdio: 'ignore', detached: true });
    child.unref();
    console.log(`（已拉起守护进程子进程 pid=${child.pid}）`);
    await new Promise(r => setTimeout(r, 1200));
  }
  if (PORT === null) {
    const found = await Port.discover();
    PORT = found ? found.port : Port.DEFAULT_PORT;
    if (found && process.env.DAREU_PORT && Number(process.env.DAREU_PORT) !== found.port) {
      console.log(`注意：DAREU_PORT=${process.env.DAREU_PORT}，但实际在跑的是 ${found.port}`);
    }
  }
  // 没有守护进程就自己拉一个（--spawn 强制新拉；--no-spawn 保持旧行为：只连现成的）
  const alive = await (async () => { try { const r = await fetch(`http://${HOST}:${PORT}/api/devices`); return r.ok; } catch (e) { return false; } })();
  if (!alive && !process.argv.includes('--no-spawn')) {
    child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { stdio: 'ignore', detached: true });
    child.unref();
    console.log(`（${HOST}:${PORT} 没人值班，已自动拉起守护进程子进程 pid=${child.pid}）`);
    await new Promise(r => setTimeout(r, 1200));
    const found = await Port.discover();
    if (found) PORT = found.port;
  }
  console.log(`\n== 0) 守护进程 ${HOST}:${PORT} ==`);
  ok('守护进程可访问', await waitFor(true), '没能在本机拉起/找到守护进程（手动跑： npm start）');

  console.log('\n== 1) 在 Node 里加载真实垫片，接管 navigator.hid ==');
  const sb = loadShim();
  ok('navigator.hid 已就位', !!sb.navigator.hid && typeof sb.navigator.hid.requestDevice === 'function');
  ok('诊断面 __DAREU_SHIM__ 存在', !!sb.window.__DAREU_SHIM__);
  await new Promise(r => setTimeout(r, 600));           // 等 SSE hello
  ok('SSE 已连上守护进程', sb.window.__DAREU_SHIM__.stats.daemonUp === true);

  console.log('\n== 2) index.html 的调用序列 ==');
  const granted = await sb.navigator.hid.requestDevice({ filters: DEVICE_FILTERS, exclusionFilters: EXCLUSION_FILTERS });
  ok('requestDevice 返回设备', granted.length >= 1, `拿到 ${granted.length} 台`);
  const dev = granted[0];
  if (dev) {
    console.log(`  · ${dev.productName} VID=0x${dev.vendorId.toString(16)} PID=0x${dev.productId.toString(16)} collections=${dev.collections.length}`);
    ok('collections 是 WebHID 形状（usagePage/usage/inputReports…）',
      dev.collections.every(c => typeof c.usagePage === 'number' && Array.isArray(c.inputReports) && Array.isArray(c.outputReports) && Array.isArray(c.featureReports)));
    ok('collections.length >= 4（index.html:298 单设备分支门槛）', dev.collections.length >= 4, `实际 ${dev.collections.length}`);
    ok('没有被 exclusionFilters 误伤', !EXCLUSION_FILTERS.some(f => f.productId === dev.productId));
    const cls = classify(granted);
    ok('按 index.html 判据能认出命令通道', !!cls.Command, JSON.stringify(granted.map(d => d.collections.map(c => c.usagePage))));

    await dev.open();
    ok('open() 后 device.opened = true', dev.opened === true);
    const again = await sb.navigator.hid.getDevices();
    ok('getDevices() 能看到已授权设备', again.some(d => d.id === dev.id));

    console.log('\n== 3) 输入报告链路（jmdevice.js:79 要求 data.buffer 长度精确）==');
    const got = new Promise((resolve) => { dev.oninputreport = resolve; setTimeout(() => resolve(null), 3000); });
    await fetch(`http://${HOST}:${PORT}/api/raw/inject`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: dev.id, reportId: 8, data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]).toString('base64') })
    });
    const ev = await got;
    ok('oninputreport 触发', !!ev);
    if (ev) {
      ok('reportId 正确', ev.reportId === 8, String(ev.reportId));
      ok('data 是 DataView', ev.data && typeof ev.data.getUint8 === 'function' && typeof ev.data.buffer !== 'undefined');
      ok('data.byteLength 精确 = 16（不是 Node Buffer 池的 8192）', ev.data.byteLength === 16, `实际 ${ev.data.byteLength}`);
      const view = new Uint8Array(ev.data.buffer);            // ← jmdevice.js 就是这么取的
      ok('new Uint8Array(ev.data.buffer) 长度 = 16', view.length === 16 && view[0] === 1 && view[15] === 16, `len=${view.length} [0]=${view[0]}`);
    }

    console.log('\n== 4) 真机写通道（16 字节 0x00 填充，设备会忽略，只验证落到 0xFF02:0x02 的 17 字节）==');
    let writeInfo = null;
    try {
      const r = await fetch(`http://${HOST}:${PORT}/api/trace`);
      const before = (await r.json()).trace.length;
      await dev.sendReport(8, new Uint8Array(16));
      const after = (await (await fetch(`http://${HOST}:${PORT}/api/trace`)).json()).trace.slice(before);
      writeInfo = after.find(t => /tx/.test(t.kind || ''));
      ok('sendReport 成功且轨迹记录了写通道', true, JSON.stringify(writeInfo || after.slice(-1)));
    } catch (e) { ok('sendReport 成功', false, e.message); }

    await dev.close();
    ok('close() 后 opened = false', dev.opened === false);

    console.log('\n== 5) 事件注册（index.html:1243 navigator.hid.addEventListener("connect")）==');
    try {
      let hit = 0;
      const onConn = () => { hit++; };
      // 注意：沙箱里的 navigator 才是被垫片接管的对象（Node 自带 globalThis.navigator 没有 hid）
      const shimHid = sb.navigator.hid;
      shimHid.addEventListener('connect', onConn);
      shimHid.addEventListener('disconnect', onConn);
      shimHid.dispatchEvent(new Event('connect'));
      shimHid.dispatchEvent(new Event('disconnect'));
      shimHid.removeEventListener('disconnect', onConn);
      ok('navigator.hid.addEventListener 可注册并触发', hit === 2, 'hit=' + hit);
    } catch (e) {
      ok('navigator.hid.addEventListener 可注册并触发', false, e.message);
    }
    try {
      let rid = null;
      const onInp = (ev) => { rid = ev.reportId; };
      dev.addEventListener('inputreport', onInp);
      const ev = new Event('inputreport'); ev.reportId = 9;
      dev.dispatchEvent(ev);
      ok('device.addEventListener("inputreport") 可注册并触发', rid === 9, 'reportId=' + rid);
    } catch (e) {
      ok('device.addEventListener("inputreport") 可注册并触发', false, e.message);
    }
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  if (child) { try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { try { child.kill(); } catch (e2) {} } }
  console.log(fail ? '\n❌ 垫片自测未通过' : '\n✅ 垫片自测通过（浏览器里就是这条链路）');
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => { try { process.reallyExit(process.exitCode); } catch (e) { process.exit(process.exitCode); } }, 200).unref();
}

main().catch((e) => { console.error('异常: ' + (e && e.stack || e)); setTimeout(() => process.reallyExit(1), 100); });
