#!/usr/bin/env node
/**
 * dareu 协议层真机自测  (src/test-protocol.js)
 *
 * 目的：证明 webapp 的协议层（js/device/**.js）在「DOM 之外的纯 Node 环境」里也能跑，
 * 并且通过我们的 node-hid 通道与真实设备完成一次完整报文往返。
 * 这是「webapp 零改动复用」这条路线的决定性证据——也是无 GUI 的回归测试入口。
 *
 *   node src/test-protocol.js                # 自动挑一台已识别的 2.4G 接收器（默认 PID 1227）
 *   node src/test-protocol.js 1227           # 指定 PID（十六进制）
 *   node src/test-protocol.js --dry-run      # 只加载协议层，不发任何报文
 *
 * 只发**只读**命令：GetDeviceInfo / GetWirelessConnectState / CheckActive / GetFirmwareVersion。
 * 不写任何配置、不进升级模式。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { HidService } = require('./hid-service.js');

const ROOT = path.join(__dirname, '..');
const WEBAPP = path.join(ROOT, 'webapp');
if (!fs.existsSync(path.join(WEBAPP, 'index.html'))) {
  console.error('缺少官方前端资源：' + WEBAPP + '\\index.html 不存在。');
  console.error('本仓库不分发那套静态资源 —— 请把自己机器上 web_driver 的内容（index.html / js / pages / …）');
  console.error('放进上面那个目录再跑。详见 README 的「获取 webapp」。');
  process.exit(2);
}

/* ---------------- DOM 桩：只为让 webapp 脚本能加载，不参与报文逻辑 ---------------- */

const stubCache = new Map();
function stub(name) {
  if (stubCache.has(name)) return stubCache.get(name);
  const fn = function () {};
  const p = new Proxy(fn, {
    get(t, k) {
      if (k === 'then' || k === Symbol.toPrimitive) return k === 'then' ? undefined : () => `[stub ${name}]`;
      if (typeof k === 'symbol' || k === 'length' || k === 'name' || k === 'prototype' || k === 'caller') return t[k];
      if (k === 'cookie' || k === 'href' || k === 'pathname') return '';
      if (k === 'style' || k === 'dataset') return stub(name + '.' + String(k));
      return stub(name + '.' + String(k));
    },
    set() { return true; },
    apply() { return stub(name + '()'); },
    construct() { return stub('new ' + name); },
    has() { return true; }
  });
  stubCache.set(name, p);
  return p;
}

function makeSandbox() {
  const mem = new Map();
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    TextEncoder, TextDecoder, URL, URLSearchParams,
    Promise, JSON, Math, Date, RegExp, Error, TypeError, RangeError, Number, String, Boolean, Object, Array, Map, Set, Buffer,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; }
    },
    sessionStorage: null,
    fetch: () => Promise.reject(new Error('test-protocol: 网络请求已禁用（产品接口 https://dr.dareu.com/v1 不参与自测）')),
    XMLHttpRequest: function () { throw new Error('test-protocol: 不用 XHR'); },
    WebSocket: function () { throw new Error('test-protocol: 不用 WebSocket'); },
    navigator: { userAgent: 'node-dareu-test', language: 'zh-CN', platform: process.platform, hardwareConcurrency: 8, hid: undefined },
    location: { href: 'http://127.0.0.1:8082/index.html', origin: 'http://127.0.0.1:8082', protocol: 'http:', host: '127.0.0.1:8082', hostname: '127.0.0.1', port: '8082', pathname: '/index.html', search: '', hash: '', reload() {}, assign() {} },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
    alert() {}, confirm: () => true, open: () => null, focus() {}, blur() {}, scrollTo() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    getComputedStyle: () => ({}),
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
    // jQuery：协议层不用，但 tools.js 顶层可能碰 $()
    $: jQueryStub(),
    jQuery: jQueryStub()
  };
  sandbox.sessionStorage = sandbox.localStorage;
  sandbox.document = stub('document');
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function jQueryStub() {
  const chain = new Proxy(function () {}, {
    get(t, k) {
      if (k === 'then') return undefined;
      if (k === 'fn' || k === 'ajax' || k === 'each' || k === 'extend') return jQueryStub();
      return chain;
    },
    apply() { return chain; },
    construct() { return chain; },
    set() { return true; }
  });
  return chain;
}

/* ---------------- 加载协议层 ---------------- */

const SCRIPTS = [
  'js/tools.js', 'js/mouse.js', 'js/keyboard.js', 'js/macro.js', 'js/lighting.js',
  'js/device.js', 'js/enumeration.js',
  'js/device/tgdevice.js', 'js/device/jmdevice.js', 'js/device/qfdevice.js',
  'js/device/ohiddevice.js', 'js/device/hydevice.js', 'js/global.js', 'js/queue.js'
];

function loadProtocolLayer(log) {
  const sandbox = makeSandbox();
  const ctx = vm.createContext(sandbox, { name: 'dareu-protocol' });
  const failed = [];
  for (const rel of SCRIPTS) {
    const file = path.join(WEBAPP, rel);
    if (!fs.existsSync(file)) { failed.push([rel, '文件不存在']); continue; }
    try {
      vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'webapp/' + rel });
      log(`  ✓ ${rel}`);
    } catch (e) {
      failed.push([rel, e.message]);
      log(`  ✗ ${rel}: ${e.message}`);
    }
  }
  let api = {};
  try {
    vm.runInContext(`globalThis.__api = {
      DongleBase: typeof DongleBase !== 'undefined' ? DongleBase : null,
      MouseBase: typeof MouseBase !== 'undefined' ? MouseBase : null,
      KeyboardBase: typeof KeyboardBase !== 'undefined' ? KeyboardBase : null,
      JmHidDevice: typeof JmHidDevice !== 'undefined' ? JmHidDevice : null,
      JmMouse: typeof JmMouse !== 'undefined' ? JmMouse : null,
      JmKeyboard: typeof JmKeyboard !== 'undefined' ? JmKeyboard : null,
      TgMouse: typeof TgMouse !== 'undefined' ? TgMouse : null,
      TgKeyboard: typeof TgKeyboard !== 'undefined' ? TgKeyboard : null,
      TgRtKeyboard: typeof TgRtKeyboard !== 'undefined' ? TgRtKeyboard : null,
      OhidKeyboard: typeof OhidKeyboard !== 'undefined' ? OhidKeyboard : null,
      OhidWirelessKeyboard: typeof OhidWirelessKeyboard !== 'undefined' ? OhidWirelessKeyboard : null,
      HyKeyboard: typeof HyKeyboard !== 'undefined' ? HyKeyboard : null,
      QfMouse: typeof QfMouse !== 'undefined' ? QfMouse : null,
      JmkeyboardHidDevice: typeof JmkeyboardHidDevice !== 'undefined' ? JmkeyboardHidDevice : null,
      TgDongleHidDevice: typeof TgDongleHidDevice !== 'undefined' ? TgDongleHidDevice : null,
      HidUsbDeviceBase: typeof HidUsbDeviceBase !== 'undefined' ? HidUsbDeviceBase : null,
      JM_WIRELESS_MAP: typeof JM_WIRELESS_MAP !== 'undefined' ? JM_WIRELESS_MAP : null,
      DEVICE_FILTERS: typeof DEVICE_FILTERS !== 'undefined' ? DEVICE_FILTERS : null
    };`, ctx);
    api = sandbox.__api;
  } catch (e) {
    log('  ✗ 导出协议类失败: ' + e.message);
  }
  return { ctx, sandbox, failed, api };
}

/* ---------------- 桥：WebHID 设备对象 → HidService(node-hid) ---------------- */

function makeHidDevice(svc, id) {
  const info = svc.publicDevice(id);
  if (!info) throw new Error('未知设备 ' + id);
  const rx = (r) => {
    if (r.id !== id || typeof dev.oninputreport !== 'function') return;
    const bytes = Buffer.from(r.data);
    const u8 = new Uint8Array(bytes.length);        // 独立 ArrayBuffer，长度恰好等于报告
    u8.set(bytes);
    try { dev.oninputreport({ device: dev, reportId: r.reportId, data: new DataView(u8.buffer) }); }
    catch (e) { console.error('[rx] oninputreport 抛错:', e.message); }
  };
  const toBuf = (d) => (d instanceof ArrayBuffer ? Buffer.from(new Uint8Array(d))
    : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength)
    : Buffer.from(Array.isArray(d) ? d : []));

  const dev = {
    vendorId: info.vendorId, productId: info.productId, productName: info.productName,
    serialNumber: info.serialNumber, collections: info.collections, opened: false, oninputreport: null,
    async open() { svc.open(id); dev.opened = true; svc.on('inputreport', rx); },
    async close() { svc.off('inputreport', rx); dev.opened = false; try { svc.close(id); } catch (e) {} },
    async sendReport(reportId, data) { svc.sendReport(id, reportId, toBuf(data)); },
    async sendFeatureReport(reportId, data) {
      const buf = toBuf(data);
      svc.sendFeatureReport(id, buf[0] !== undefined ? buf[0] : reportId, buf);
    },
    async receiveFeatureReport(reportId) {
      const r = svc.receiveFeatureReport(id, reportId);
      const u8 = new Uint8Array(r.data.length);
      u8.set(r.data);
      return new DataView(u8.buffer);
    },
    __info: info
  };
  return dev;
}

/* ---------------- 主流程 ---------------- */

function pickDevice(svc, pidHex) {
  const all = svc.allDevices();
  if (!all.length) throw new Error('没有发现任何 HID 设备（确认接收器/键鼠已插入，VID 在 hid-profiles.json 的 vendorIds 里）');
  if (pidHex) {
    const want = String(pidHex).toUpperCase();
    const hit = all.filter(d => d.pidHex === want || String(d.productId) === String(pidHex));
    if (!hit.length) throw new Error(`没找到 PID=${want} 的设备。现有：` + all.map(d => `${d.pidHex}/${d.productName}`).join(', '));
    // 优先匠盟命令通道（0xFF02:0x02），否则取第一个
    return hit.find(d => d.collectionKey === '0xFF02:0x02') || hit[0];
  }
  return all.find(d => d.collectionKey === '0xFF02:0x02' && d.fwType === 2) || all.find(d => d.fwType === 2) || all[0];
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const pidArg = args.find(a => /^[0-9a-fA-F]{3,4}$/.test(a));
  const log = console.log;

  log('== 1) 在 Node 沙箱里加载 webapp 协议层（不加载任何 DOM 实现）==');
  const { ctx, sandbox, failed, api } = loadProtocolLayer(log);
  log(`  加载结果：${SCRIPTS.length - failed.length}/${SCRIPTS.length} 个脚本成功` + (failed.length ? '，失败：' + failed.map(f => f[0]).join(', ') : ''));
  const needed = ['DongleBase', 'HidUsbDeviceBase', 'JmHidDevice'];
  const missing = needed.filter(k => !api[k]);
  if (missing.length) { log(`  ✗ 缺少关键类：${missing.join(', ')} —— 无法继续`); hardExit(2); }
  log(`  ✓ 类可用：${needed.join(', ')}${api.JM_WIRELESS_MAP ? '，JM_WIRELESS_MAP=' + api.JM_WIRELESS_MAP.length + ' 条' : ''}`);

  if (dry) { log('\n--dry-run：不碰硬件，结束。'); return; }

  log('\n== 2) 用 node-hid 打开通道，构造 WebHID 设备对象 ==');
  const svc = new HidService({ log: (m) => log('   [hid] ' + m) });
  svc.refresh();
  const target = pickDevice(svc, pidArg);
  log(`  目标设备：PID ${target.pidHex} ${target.productName} 家族 ${target.family} FwType ${target.fwType} 集合 ${target.collectionKey}`);
  log(`  hidapi path：${target.path}`);

  const device = makeHidDevice(svc, target.id);
  await device.open();
  log(`  ✓ 已打开（opened=${device.opened}），collections=${device.collections.length}（合成自 hid-profiles.json）`);

  // 复刻 index.html 的通知派发：device.oninputreport → DeviceNotification → context.HidDevice.GetReportFunc
  const NotificationCallback = [];
  device.oninputreport = function (event) {
    for (const param of NotificationCallback) {
      if (typeof param === 'function') { try { param(event); } catch (e) { log('   通知回调抛错: ' + e.message); } }
      else if (param && typeof param.callback === 'function') {
        try { param.callback({ event, context: param.context }); } catch (e) { log('   通知回调抛错: ' + e.message); }
      }
    }
  };

  log('\n== 3) 跑真实只读命令（new DongleBase(device, FwType) 与 index.html:20619 一致）==');
  const out = vm.runInContext(`(function(dev, fw){
     var dongle = new DongleBase(dev, fw);
     return { dongle: dongle, hid: dongle.HidDevice, cls: dongle.HidDevice.constructor.name };
  })`, ctx)(device, target.fwType);
  log(`  HidDevice 实例 = ${out.cls}（CreateHidDevice 按 FwType=${target.fwType}, Type=2 选择）`);
  log(`  ReportId=0x${out.hid.ReportId.toString(16)} REPORT_SIZE=${out.hid.REPORT_SIZE} TargetId=${out.hid.TargetId} WirelessFlag=${out.hid.WirelessFlag}`);
  NotificationCallback.push({ callback: out.dongle.GetReportCallback, context: out.dongle });

  const outParam = {};
  const call = async (name, ...extra) => {
    const t0 = Date.now();
    try {
      const ret = await vm.runInContext(`(function(d,p){ return d.${name}.apply(d, [p].concat(arguments.length>2?[].slice.call(arguments,2):[])); })`, ctx)(out.dongle, outParam, ...extra);
      return { name, ret, ms: Date.now() - t0 };
    } catch (e) {
      return { name, ret: false, ms: Date.now() - t0, error: e.message };
    }
  };

  const results = [];
  results.push(await call('GetDongleFwVersion'));
  results.push(await call('GetDeviceInfo'));
  results.push(await call('GetWirelessConnectState'));
  results.push(await call('CheckActive'));

  for (const r of results) {
    log(`  ${r.error ? '✗' : (r.ret ? '✓' : '·')} ${r.name.padEnd(24)} → ${JSON.stringify(r.ret)} (${r.ms}ms)` + (r.error ? ' 异常: ' + r.error : ''));
  }

  log('\n== 4) 从设备拿到的信息（写回 outParam，与页面同一份字段）==');
  const seen = {};
  for (const k of ['JmType', 'CID', 'MID', 'FwVer', 'DeviceFwVersion', 'FwVersion', 'ConnectInfo', 'WirelessConnectState', 'Battery', 'DeviceInfo']) {
    if (outParam[k] !== undefined) seen[k] = outParam[k];
  }
  // 与 index.html 一致：页面拿到 outParam 后回填到 dongle 实例
  out.dongle.JmType = outParam.JmType; out.dongle.CID = outParam.CID; out.dongle.MID = outParam.MID;
  seen.dongle_JmType = out.dongle.JmType; seen.dongle_CID = out.dongle.CID; seen.dongle_MID = out.dongle.MID;
  log('  ' + JSON.stringify(seen, (k, v) => (v instanceof Uint8Array ? [...v].map(x => x.toString(16).padStart(2, '0')).join(' ') : (Array.isArray(v) && v.length > 12 ? `<${v.length} 项>` : v)), 2).replace(/\n/g, '\n  '));

  // JM_WIRELESS_MAP 结构（js/global.js）：[{PID: 接收器PID, Type, PairInfo:[{PID, CID, MID, Type}]}]
  // index.html 的查法：先按接收器 PID 找到条目，再在 PairInfo 里按 CID/MID 找配对的键鼠。
  // 页面把 CheckActive 的返回值当作 isConected 传给 InitDeviceParameters（index.html:574/583）
  const checkActive = results.find(r => r.name === 'CheckActive');
  const lastRet = !!(checkActive && checkActive.ret);
  let pairHit = null;
  target.__pairHit = null;
  if (api.JM_WIRELESS_MAP) {
    const cid = outParam.CID !== undefined ? outParam.CID : out.dongle.CID;
    const mid = outParam.MID !== undefined ? outParam.MID : out.dongle.MID;
    const hx = (n) => '0x' + Number(n).toString(16).toUpperCase().padStart(4, '0');
    const entry = api.JM_WIRELESS_MAP.find(it => it.PID == target.productId);
    if (!entry) {
      log(`  JM_WIRELESS_MAP 没有接收器 PID ${hx(target.productId)} 的配对表条目（该表只覆盖部分型号，页面会退回用产品 JSON 的默认参数）`);
    } else {
      log(`  JM_WIRELESS_MAP[${hx(entry.PID)}] 可配对 ${entry.PairInfo.length} 台：` +
        entry.PairInfo.map(p => `${hx(p.PID)}/CID${p.CID}/MID${p.MID}`).join(' '));
      const hit = (entry.PairInfo || []).find(p => p.CID == cid && p.MID == mid);
      pairHit = hit || null;
      target.__pairHit = pairHit;
      log(`  实测 CID=${cid} MID=${mid} → 当前配对设备 PID = ` +
        (hit ? `${hx(hit.PID)}（products/${String(hit.PID).toLowerCase()}/${String(hit.PID).toLowerCase()}.json）` : '表里没有（设备未配对或该型号不在此表）'));
    }
  }

  // ── 5) 复刻页面「转圈圈」那一段（index.html:561-583 → JsonGetWirlessProductParameters → InitDeviceParameters）
  //     页面在 loadingpage.html 上转圈，只有这条链走到 FrameMain.src=main.html/maindisconnect.html 才会停。
  if (args.includes('--wireless')) {
    log('\n== 5) 无线端设备初始化链（页面转圈是否结束就看这段）==');
    if (!pairHit) {
      log('  ✗ 上一步没解析出配对的无线设备 PID，页面会停在 loadingpage.html（index.html:593 的空 else 分支）');
    } else {
      const pidStr = Number(pairHit.PID).toString(16).toUpperCase().padStart(4, '0');
      const prodFile = path.join(WEBAPP, 'products', pidStr, pidStr + '.json');
      if (!fs.existsSync(prodFile)) {
        log(`  ✗ 缺少 ${path.relative(ROOT, prodFile)}：fetch 404 → .catch 只 console.log → 页面永远转圈`);
      } else {
        const pdata = JSON.parse(fs.readFileSync(prodFile, 'utf8'));
        const langFile = path.join(WEBAPP, 'language', 'cn.json');
        const language = fs.existsSync(langFile) ? JSON.parse(fs.readFileSync(langFile, 'utf8')) : {};
        const type = pdata.Device.Type, fw = pdata.Device.FwType;
        const clsName = { '0_2': 'JmMouse', '1_2': 'JmKeyboard', '0_0': 'TgMouse', '1_0': 'TgKeyboard', '1_4': 'OhidWirelessKeyboard', '1_6': 'TgRtKeyboard' }[`${type}_${fw}`]
          || (type === 0 ? 'JmMouse' : 'JmKeyboard');
        log(`  配对设备 ${pidStr}（Type=${type} FwType=${fw}）→ ${clsName}(device, ${fw}, 0x00, isConected=${lastRet})`);
        let dev2;
        const Ctor = api[clsName];
        if (typeof Ctor !== 'function') {
          log(`  ✗ 协议层里没有 ${clsName} 这个类（页面里同样会抛错 → 一直转圈）`);
        } else try {
          // 与 index.html:628/650 一致：无线设备的 HidDevice 还是那只接收器，TargetId=0
          dev2 = new Ctor(device, fw, 0x00, lastRet);
        } catch (e) {
          log('  ✗ 构造设备对象就抛错（页面里是未捕获的 promise rejection → 一直转圈）: ' + e.message);
        }
        if (dev2) {
          NotificationCallback.push({ callback: dev2.GetReportCallback, context: dev2 });
          const timed = async (name, ms, fn) => {
            const t0 = Date.now();
            let to;
            try {
              const v = await Promise.race([
                (async () => fn())(),
                new Promise((_, rej) => { to = setTimeout(() => rej(new Error(`超时 ${ms}ms`)), ms); })
              ]);
              return { name, ret: v, ms: Date.now() - t0 };
            } catch (e) {
              return { name, ret: false, ms: Date.now() - t0, error: e.message };
            } finally { clearTimeout(to); }
          };
          const r1 = await timed('InitParameters', 3000, () => vm.runInContext(
            `(function(d,p,lang,conn,D){ d.InitParameters(p); d.SetLanguage(lang); d.IsConnected = conn; if (D) { d.Dongle = D; d.SetWirelessPollingRateMap(D.JmType); } return true; })`, ctx
          )(dev2, pdata, language, lastRet, out.dongle));
          log(`  ${r1.error ? '✗' : '✓'} ${r1.name.padEnd(22)} (${r1.ms}ms)` + (r1.error ? '  ' + r1.error : ''));
          const r2 = await timed('GetDeviceAtrribute', 12000, () => vm.runInContext(`(function(d){ return d.GetDeviceAtrribute(); })`, ctx)(dev2));
          log(`  ${r2.error ? '✗' : (r2.ret ? '✓' : '·')} ${r2.name.padEnd(22)} → ${JSON.stringify(r2.ret)} (${r2.ms}ms)` + (r2.error ? '  ' + r2.error : ''));
          let r3 = { name: 'GetAllDeviceConfig', ret: false, ms: 0, error: r2.ret ? null : '跳过（前一步失败）' };
          if (r2.ret) r3 = await timed('GetAllDeviceConfig', 20000, () => vm.runInContext(`(function(d){ return d.GetAllDeviceConfig(); })`, ctx)(dev2));
          log(`  ${r3.error ? '✗' : (r3.ret ? '✓' : '·')} ${r3.name.padEnd(22)} → ${JSON.stringify(r3.ret).slice(0, 40)} (${r3.ms}ms)` + (r3.error ? '  ' + r3.error : ''));
          const done = r2.ret && r3.ret;
          log('  → 页面会停在 ' + (done ? 'pages/main.html（转圈结束）' : (lastRet ? 'MessageBox + pages/init.html（CommunicateFail）' : 'pages/maindisconnect.html')));
          if (!done) log('  ⚠ 无线端（鼠标/键盘）此刻没应答：多半是设备休眠/未开机；把配对设备唤醒再跑一次');
        }
      }
    }
  }

  await device.close();
  svc.dispose();
  const ok = results.some(r => r.ret && !r.error);
  log(`\n结论：${ok ? '✅ 协议层 + node-hid 通道与真实设备完成报文往返' : '⚠️ 未收到有效应答（见上面的返回码）'}`);
  hardExit(ok ? 0 : 3);
}

/**
 * node-hid 在 Windows 上的 read(cb) 是工作线程里的阻塞 ReadFile；设备静默时 hid.close() 会等那个线程，
 * process.exit() 也可能卡在 addon 析构上。一次性进程没必要优雅退出：冲掉 stdout 就直接走人，
 * HID 句柄由系统回收（守护进程里的关闭逻辑见 hid-service.js #closeHandle）。
 */
function hardExit(code) {
  process.exitCode = code;
  const done = () => { try { process.reallyExit(code); } catch (e) { process.exit(code); } };
  const t = setTimeout(done, 500);
  t.unref?.();
  try { process.stdout.write('', done); } catch (e) { done(); }
}

main().catch((e) => { console.error('自测失败: ' + (e && e.stack || e)); hardExit(1); });
