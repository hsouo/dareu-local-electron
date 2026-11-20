#!/usr/bin/env node
/**
 * dareu CLI  (src/cli.js)
 *
 *   node src/cli.js list                        枚举 HID 设备（含家族/型号/授权状态）
 *   node src/cli.js info   <id|PID>             打印某设备的 collections 与 path
 *   node src/cli.js collections                打印每个 path 的 usagePage/usage（编写 hid-profiles.json 用）
 *   node src/cli.js probe  <id|PID>             只读探测：open + getFeatureReport 长度扫描，不发任何写报告
 *   node src/cli.js feature <id|PID> <rid> [len] getFeatureReport 十六进制输出
 *   node src/cli.js write  <id|PID> <rid> <hex> sendReport（真写硬件，自己确认报文正确）
 *   node src/cli.js feature-send <id|PID> <hex> sendFeatureReport（首字节 = reportId）
 *   node src/cli.js feed   <id|PID> <rid> <hex> 注入一条合成输入报告给页面（离线联调用，不碰硬件）
 *   node src/cli.js watch  [秒]                 打印设备事件与输入报告
 *   node src/cli.js serve                       只起守护进程（端口自动避让，写 state/daemon.json）
 *   node src/cli.js port                        打印当前守护进程在哪个端口（自动发现）
 *   node src/cli.js stop                        让守护进程退出（POST /api/shutdown）
 *
 * 守护进程在跑时走 HTTP（端口是自动分配的，CLI 会通过 state/daemon.json 自己找到），
 * 否则直接内嵌 HidService。
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const { HidService } = require('./hid-service.js');
const Port = require('./port.js');

// 内嵌模式也要能读 products/（家族默认是按产品 JSON 的 FwType 推的，少了它会显示 ?）
const PRODUCTS = path.join(__dirname, '..', 'webapp', 'products');

// 守护进程端口是自动分配的（被占了会顺延），null = 还没探测；见 src/port.js
let PORT = process.env.DAREU_PORT ? Number(process.env.DAREU_PORT) : null;
const argv = process.argv.slice(2);
const cmd = (argv[0] || 'list').toLowerCase();

// 用法就写在本文件头注释里，help / -h / --help 直接打印，不连守护进程也不枚举设备
function usage() {
  return require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*!?|^\/\*/, '').trimEnd();
}
if (['help', '-h', '--help', '?'].includes(cmd)) { console.log(usage()); process.exit(0); }

/* ---------------- 小工具 ---------------- */

function hex(buf) {
  return [...Buffer.from(buf)].map(b => b.toString(16).padStart(2, '0')).join(' ');
}
function parseHex(s) {
  const clean = String(s || '').replace(/(0x|\s|,|-)/g, '');
  if (!clean) return Buffer.alloc(0);
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) throw new Error('不是合法十六进制串: ' + s);
  return Buffer.from(clean, 'hex');
}
function dump(b) {
  const buf = Buffer.from(b);
  const out = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, i + 16);
    const ascii = [...slice].map(x => (x >= 32 && x < 127 ? x : 0x2e)).map(x => String.fromCharCode(x)).join('');
    out.push(`${i.toString(16).padStart(4, '0')}  ${hex(slice).padEnd(47)}  ${ascii}`);
  }
  out.push(`(${buf.length} bytes)`);
  return out.join('\n');
}
function pad(s, n) { s = String(s); return s.length > n - 1 ? s.slice(0, n - 1) + '…' : s.padEnd(n); }

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!PORT) return reject(new Error('没有可用的守护进程端口（先 npm start，或用 --serve 内嵌运行）'));
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { const j = JSON.parse(buf); res.statusCode < 400 ? resolve(j) : reject(new Error(j.error || ('HTTP ' + res.statusCode))); }
        catch (e) { reject(new Error('HTTP ' + res.statusCode + ' 非 JSON 响应')); }
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('超时')));
    if (data) r.write(data);
    r.end();
  });
}

/* ---------------- 设备定位（id 或 PID 都行） ---------------- */

/** 找到在跑的守护进程端口；没有就返回 null（然后走内嵌模式） */
async function findDaemon() {
  if (PORT !== null) {
    const info = await Port.probe('127.0.0.1', PORT);
    if (info) return PORT;
    if (process.env.DAREU_PORT) return null;   // 用户指定了端口却没有守护进程，不去乱扫
  }
  const found = await Port.discover();
  PORT = found ? found.port : 0;
  return found ? found.port : null;
}

async function backend() {
  const p = await findDaemon();
  if (p) {
    try {
      const st = await req('GET', '/api/state');
      return { via: `daemon ${p}`, port: p, list: st.devices, call: (m, path, b) => req(m, path, b) };
    } catch (e) { /* 刚好掉线：退回内嵌 */ }
  }
  {
    const svc = new HidService({ log: () => {}, productsDir: PRODUCTS });
    svc.refresh();
    return {
      via: 'embedded (node-hid)',
      // publicList() 已经是「公开形状」，别再套一层 publicDevice（会读不到 __paths 之类内部字段）
      list: svc.allDevices(),
      call: async (m, p, b) => {
        const id = b && b.id;
        if (p === '/api/receive-feature-report') return { data: svc.receiveFeatureReport(id, b.reportId).data.toString('base64') };
        if (p === '/api/raw/get-feature') return { data: svc.receiveFeatureReport(id, b.reportId, b.length).data.toString('base64') };
        if (p === '/api/raw/write') return svc.sendReport(id, b.reportId, Buffer.from(b.data, 'base64'));
        if (p === '/api/raw/feature') return svc.sendFeatureReport(id, b.reportId, Buffer.from(b.data, 'base64'));
        if (p === '/api/raw/inject') return svc.injectReport(id, b.reportId, b.data);
        if (p === '/api/open') { svc.open(id); return { ok: true }; }
        throw new Error('CLI 内嵌模式不支持 ' + p);
      },
      dispose: () => svc.dispose()
    };
  }
}

function findDevice(list, key) {
  if (!key) return null;
  const up = String(key).toUpperCase();
  return list.find(d => d.id === key)
    || list.find(d => d.id.toUpperCase().startsWith(up))
    || list.find(d => d.pidHex === up || d.productId === parseInt(up, 16))
    || null;
}

function resolve(list, key) {
  const d = findDevice(list, key);
  if (d) return d;
  const guess = list.find(x => String(x.productId) === String(key));
  if (guess) return guess;
  throw new Error(`找不到设备 "${key}"。可用：\n` + list.map(x => `  ${x.id}  ${x.pidHex} ${x.productName}`).join('\n'));
}

/* ---------------- 命令 ---------------- */

async function main() {
  // 这几个命令只跟守护进程说话，不需要设备表（内嵌模式还会去抢开 HID 设备，纯属添乱）
  const DAEMON_ONLY = new Set(['stop', 'port', 'serve', 'help', '-h', '--help', '?']);
  let bt = { via: '', list: [] };
  if (!DAEMON_ONLY.has(cmd)) {
    bt = await backend();
    console.log(`# ${bt.via}`);
  } else if (cmd === 'stop' || cmd === 'port') {
    await findDaemon();          // 只做端口发现，不建内嵌 HidService
  }
  const list = bt.list;
  const arg = (i) => argv[i + 1];

  try {
    switch (cmd) {
      case 'list': {
        if (!list.length) { console.log('没有发现 HID 设备。确认设备已插入，且 VID 在 src/hid-profiles.json 的 vendorIds 里。'); break; }
        console.log(pad('ID', 30) + pad('VID:PID', 13) + pad('家族', 8) + pad('FwType', 7) + pad('授权', 6) + '型号 / 产品名');
        for (const d of list) {
          console.log(
            pad(d.id, 30) +
            pad('0x' + (d.vendorId || 0).toString(16).padStart(4, '0') + ':' + (d.productId || 0).toString(16).padStart(4, '0'), 13) +
            pad(d.family || '?', 8) + pad('0x' + ((d.fwType || 0).toString(16)), 7) +
            pad(d.authorized ? 'yes' : '-', 6) + `${d.model || ''} ${d.productName || ''}`
          );
        }
        break;
      }
      case 'info': {
        const d = resolve(list, arg(0));
        console.log(JSON.stringify(d, null, 2));
        break;
      }
      case 'collections': {
        for (const d of list) {
          console.log(`${d.id}  ${d.pidHex || ''} ${d.productName}  [${d.family || '?'}]`);
          for (const c of d.collections || []) {
            console.log(`    usagePage=0x${(c.usagePage || 0).toString(16)} usage=0x${(c.usage || 0).toString(16)} ` +
              `input=[${(c.inputReports || []).map(r => '0x' + r.reportId.toString(16)).join(',')}] ` +
              `output=[${(c.outputReports || []).map(r => '0x' + r.reportId.toString(16)).join(',')}] ` +
              `feature=[${(c.featureReports || []).map(r => '0x' + r.reportId.toString(16)).join(',')}] ` +
              `children=${(c.childLinks || []).length}`);
          }
        }
        break;
      }
      case 'probe': {
        const d = resolve(list, arg(0));
        console.log(`设备 ${d.id}  家族 ${d.family}  path ${d.path || (d.paths || []).join('\n              ')}`);
        await bt.call('POST', '/api/open', { id: d.id });
        const lengths = (require('./hid-profiles.json').featureReportProbeLengths || [65, 64, 33, 17, 9]);
        const rids = new Set();
        for (const c of d.collections || []) for (const r of (c.featureReports || [])) rids.add(r.reportId);
        for (const rid of (rids.size ? rids : new Set([0, 3, 7, 8, 10]))) {
          let line = `  getFeatureReport(0x${rid.toString(16)}):`;
          for (const L of lengths) {
            try {
              const r = await bt.call('POST', '/api/raw/get-feature', { id: d.id, reportId: rid, length: L });
              const b = Buffer.from(r.data, 'base64');
              line += ` len${L}=ok(${b.length}) ${b.some(x => x) ? '有数据' : '全零'};`;
              break;
            } catch (e) { line += ` len${L}=×;`; }
          }
          console.log(line);
        }
        console.log('  （probe 只做读操作，未发送任何写报告）');
        break;
      }
      case 'feature': {
        const d = resolve(list, arg(0));
        const rid = parseInt(arg(1), 0) || 0;
        const r = await bt.call('POST', '/api/raw/get-feature', { id: d.id, reportId: rid, length: parseInt(arg(2), 0) || 0 });
        console.log(`getFeatureReport(0x${rid.toString(16)}) @ ${d.id}\n` + dump(Buffer.from(r.data, 'base64')));
        break;
      }
      case 'write': {
        const d = resolve(list, arg(0));
        const rid = parseInt(arg(1), 0) || 0;
        const buf = parseHex(arg(2));
        const r = await bt.call('POST', '/api/raw/write', { id: d.id, reportId: rid, data: buf.toString('base64') });
        console.log(`sendReport(0x${rid.toString(16)}, ${buf.length}B) → ${JSON.stringify(r)}`);
        break;
      }
      case 'feature-send': {
        const d = resolve(list, arg(0));
        const buf = parseHex(arg(1));
        const rid = buf[0] || 0;
        const r = await bt.call('POST', '/api/raw/feature', { id: d.id, reportId: rid, data: buf.toString('base64') });
        console.log(`sendFeatureReport(0x${rid.toString(16)}, ${buf.length}B) → ${JSON.stringify(r)}`);
        break;
      }
      case 'feed': {
        const d = resolve(list, arg(0));
        const buf = parseHex(arg(2));
        const r = await bt.call('POST', '/api/raw/inject', { id: d.id, reportId: parseInt(arg(1), 0) || 0, data: buf.toString('base64') });
        console.log(`已注入合成输入报告 → ${JSON.stringify(r)}（页面需已 open 该设备并在监听 inputreport）`);
        break;
      }
      case 'watch': {
        const secs = parseInt(arg(0), 10) || 10;
        if (bt.via.startsWith('embedded')) {
          const svc = (function () { const s = new HidService({ log: console.log, productsDir: PRODUCTS }); s.refresh(); return s; })();
          svc.on('inputreport', (r) => console.log(`[rx] ${r.id} reportId=0x${(r.reportId || 0).toString(16)} ${hex(r.data)}`));
          svc.startPolling(1000);
          console.log(`监听 ${secs}s（内嵌模式，仅本进程打开的设备能收到报告；要看页面的流量请用 daemon 模式的 SSE /api/events）`);
        } else {
          console.log(`监听 ${secs}s → GET /api/events (SSE)`);
          const res = await new Promise((resolve, reject) => {
            const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events' }, resolve);
            r.on('error', reject);
          });
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const evt = buf.slice(0, i); buf = buf.slice(i + 2);
              const name = (evt.match(/^event: (.*)$/m) || [])[1];
              const data = (evt.match(/^data: (.*)$/m) || [])[1];
              if (!name) continue;
              if (name === 'inputreport') { const p = JSON.parse(data); console.log(`[rx] ${p.id} reportId=0x${p.reportId.toString(16)} ${Buffer.from(p.data, 'base64').toString('hex')}`); }
              else if (name === 'trace') { const t = JSON.parse(data); console.log(`[${t.kind}] ${t.line}`); }
              else if (name !== 'hello' && name !== 'state') console.log(`[${name}] ${(data || '').slice(0, 200)}`);
            }
          });
        }
        await new Promise(r => setTimeout(r, secs * 1000));
        process.exit(0);
        break;
      }
      case 'serve': {
        const { createServer } = require('./server.js');
        const s = createServer();
        const { port, note } = await s.start();
        console.log(`守护进程已启动 → http://127.0.0.1:${port}/   (Ctrl+C 退出)`);
        if (note) console.log(`端口提示: ${note}`);
        s.svc.startPolling();
        Port.writePortFile({ service: Port.SERVICE, host: '127.0.0.1', port, url: `http://127.0.0.1:${port}/`, pid: process.pid, startedAt: new Date().toISOString() });
        const bye = () => { Port.clearPortFile(port); s.svc.dispose(); s.server.close(); process.exit(0); };
        process.on('SIGINT', bye); process.on('SIGTERM', bye);
        await new Promise(r => setTimeout(r, 24 * 3600 * 1000));
        break;
      }
      case 'port': {
        const f = await Port.discover();
        const rec = Port.readPortFile();
        console.log(f
          ? `守护进程在 http://127.0.0.1:${f.port}/  (pid=${f.info.pid}, 设备 ${f.info.devices ? f.info.devices.length : '?'} 台, hidapi ${f.info.hidapi})`
          : `没有发现正在运行的守护进程${rec ? `（state/daemon.json 记着 ${rec.port}，但那个进程已经不在了）` : ''}`);
        break;
      }
      case 'stop': {
        const p = await findDaemon();
        if (!p) { console.log('没有正在运行的守护进程。'); break; }
        try { await req('POST', '/api/shutdown', {}); console.log(`已让端口 ${p} 上的守护进程退出。`); }
        catch (e) { console.log(`端口 ${p} 无响应：${e.message}`); }
        break;
      }
      default:
        console.log('未知命令: ' + cmd + '\n\n' + usage());
        process.exitCode = 2;
    }
  } finally {
    if (bt.dispose) bt.dispose();
  }
}

main().catch((e) => { console.error('错误: ' + (e && e.message || e)); process.exit(1); });
