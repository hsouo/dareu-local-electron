/*!
 * dareu WebHID shim  (src/shim/hid-shim.js)
 *
 * 让原始 webapp（web_driver 整仓，字节级零改动）在「没有 WebHID」的环境里跑起来：
 * 它把 navigator.hid 实现为一层转发，报文由本机守护进程 src/server.js 用 node-hid 收发。
 *
 * 语义严格对齐 Chromium / webhid.quirks：
 *  - 一个 shim 设备 = 守护进程里的一个 HID 接口（顶层集合），id = 稳定路径键
 *  - device.collections 由守护进程按 src/hid-profiles.json 合成（hidapi 拿不到 report descriptor）
 *  - 授权持久化在守护进程 state/authorized.json，无浏览器弹窗（本地工具，等价于「一次全部允许」）
 *  - requestDevice 的 exclusionFilters 必须实现：否则排除规则失效，会选中非驱动接口的设备，
 *    驱动直接卡死在 "Connecting to HID device"（index.html:581 靠 HidReady 才置 true）
 *  - oninputreport 与 addEventListener('inputreport') 双通道都要触发：子页面（pages/subpage/**）
 *    两种写法都有，且拿不到 device 对象，只能靠 navigator.hid.getDevices() 自己找
 *  - event.data 的 DataView 必须建立在长度恰好等于报告的 ArrayBuffer 上：
 *    jmdevice.js:79 会取 new Uint8Array(t.data.buffer)，Node 侧 Buffer 的 .buffer 是共享池，
 *    所以守护进程只发精确字节，这里再用 atob 生成独立 buffer
 *
 * 注入方式：守护进程在 GET /index.html 时动态插入 <script src="/hid-shim.js">，webapp 不改。
 */
(function () {
  'use strict';

  var DAEMON = 'http://' + (location.hostname || '127.0.0.1') + ':' + (location.port || '8082');
  var log = function () {
    var a = ['[hid-shim]'];
    for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
    (console.info || console.log).apply(console, a);
  };
  var warn = function () {
    var a = ['[hid-shim]'];
    for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
    console.warn.apply(console, a);
  };

  /* ---------------- 字节 <-> base64 ---------------- */

  function toBytes(data) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === 'string') {
      var s = atob(data), u = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      return u;
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      var v = data;
      return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    }
    if (Array.isArray(data)) return new Uint8Array(data);
    throw new TypeError('无法转换为字节序列');
  }

  function toB64(data) {
    var u = toBytes(data), s = '', CHUNK = 0x8000;
    for (var i = 0; i < u.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  /* ---------------- 守护进程调用 ---------------- */

  function api(path, body) {
    return fetch(DAEMON + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) {
          var e = new Error(j && j.error ? j.error : ('HTTP ' + res.status + ' ' + path));
          e.status = res.status;
          e.code = j && j.code;
          throw e;
        }
        return j;
      });
    });
  }

  /* ---------------- 设备 ---------------- */

  var devices = new Map();   // id -> ShimDevice

  // 注意：必须用 class extends EventTarget。Chromium 的 EventTarget 是 class，
  // 老式 EventTarget.call(this) 会直接抛 "Class constructor EventTarget cannot be invoked without 'new'"。
  class ShimDevice extends EventTarget {
    constructor(info) {
      super();
      this.oninputreport = null;
      this._open = false;
      this.update(info);
    }
    update(info) {
      this.id = info.id;
      this.vendorId = info.vendorId;
      this.productId = info.productId;
      this.productName = info.productName || '';
      this.serialNumber = info.serialNumber || '';
      this.collections = info.collections || [];
      this.usagePage = this.collections[0] ? this.collections[0].usagePage : 0;
      this.usage = this.collections[0] ? this.collections[0].usage : 0;
      this.physical = info.physical || '';
      this.daemonPath = info.path || '';
      if (typeof info.opened === 'boolean') this._open = info.opened;
    }
    get opened() { return this._open; }
    open() {
      var self = this;
      return api('/api/open', { id: this.id }).then(function () { self._open = true; });
    }
    close() {
      var self = this;
      return api('/api/close', { id: this.id }).then(function () { self._open = false; });
    }
    sendReport(reportId, data) {
      stats.sends++;
      return api('/api/send-report', { id: this.id, reportId: reportId | 0, data: toB64(data) });
    }
    sendFeatureReport(reportId, data) {
      if (data === undefined) { data = toBytes(reportId); reportId = data[0]; }
      stats.features++;
      return api('/api/send-feature-report', { id: this.id, reportId: reportId | 0, data: toB64(data) });
    }
    receiveFeatureReport(reportId) {
      stats.receives++;
      return api('/api/receive-feature-report', { id: this.id, reportId: reportId | 0 }).then(function (r) {
        var u = toBytes(r.data);
        return new DataView(u.buffer);   // 独立且长度精确的 ArrayBuffer
      });
    }
  }

  function fireInput(dev, reportId, bytes) {
    var u = toBytes(bytes);              // atob 产物：byteLength 恰好等于报告长度，独立 ArrayBuffer
    var view = new DataView(u.buffer);
    if (typeof dev.oninputreport === 'function') {
      try { dev.oninputreport({ device: dev, reportId: reportId, data: view }); }
      catch (e) { warn('oninputreport 回调抛错', e); }
    }
    try {
      var ev = new Event('inputreport');
      ev.device = dev; ev.reportId = reportId; ev.data = view;
      dev.dispatchEvent(ev);
    } catch (e) { warn('inputreport 事件派发失败', e); }
    stats.inputs++;
    if (stats.lastInput) { stats.lastInput.reportId = reportId; stats.lastInput.bytes = u.length; }
  }

  /* ---------------- navigator.hid ---------------- */

  var stats = { requests: 0, sends: 0, features: 0, receives: 0, inputs: 0, lastInput: null, daemonUp: false, lastError: null };
  var pendingConnect = [];   // 等 getDevices() 兑现的 connect 事件

  function remember(info) {
    var d = devices.get(info.id);
    if (d) { d.update(info); return d; }
    d = new ShimDevice(info);
    devices.set(info.id, d);
    return d;
  }

  function matchesFilter(info, f) {
    if (typeof f !== 'object' || f === null) return false;
    if ('vendorId' in f && f.vendorId !== undefined && info.vendorId !== f.vendorId) return false;
    if ('productId' in f && f.productId !== undefined && info.productId !== f.productId) return false;
    if ('serialNumber' in f && f.serialNumber !== undefined && (info.serialNumber || '') !== f.serialNumber) return false;
    if ('usagePage' in f || 'usage' in f) {
      var up = 'usagePage' in f ? f.usagePage : null;
      var us = 'usage' in f ? f.usage : null;
      var cols = info.collections || [];
      var hit = false;
      for (var i = 0; i < cols.length; i++) {
        if ((up === null || cols[i].usagePage === up) && (us === null || cols[i].usage === us)) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }

  function anyMatch(info, list) {
    if (!list || !list.length) return false;
    for (var i = 0; i < list.length; i++) if (matchesFilter(info, list[i])) return true;
    return false;
  }

  // 守护进程的 authorized 字段是 id 列表（devices 是完整对象），这里统一还原成设备对象
  function pickAuthorized(r) {
    var set = {};
    (r && r.authorized || []).forEach(function (id) { set[id] = 1; });
    var list = (r && r.devices || []).filter(function (d) { return set[d.id]; });
    list.forEach(remember);
    return list.map(function (d) { return devices.get(d.id); });
  }

  // 必须是真正的 EventTarget 实例：Object.setPrototypeOf(普通对象, EventTarget.prototype)
  // 会让原生 addEventListener 抛 "Illegal invocation"（内部 [[EventTargetData]] 槽缺失），
  // index.html:1243 正是 navigator.hid.addEventListener("connect", …)。
  var HIDShim = new EventTarget();
  Object.assign(HIDShim, {
    getDevices: function () {
      return api('/api/devices').then(function (r) {
        stats.daemonUp = true;
        return pickAuthorized(r);
      }).catch(function (e) {
        stats.daemonUp = false; stats.lastError = String(e && e.message || e);
        warn('守护进程不可用（' + DAEMON + '）：', stats.lastError);
        return [];
      });
    },

    // 无浏览器选择框：按 filters/exclusionFilters 直接命中并持久授权（等价「一次全部允许」）
    requestDevice: function (options) {
      options = options || {};
      stats.requests++;
      log('requestDevice', JSON.stringify(options));
      return api('/api/refresh', {}).then(function (r) {
        var all = r.devices || [];
        var picked = all.filter(function (i) {
          if (options.filters && options.filters.length) return anyMatch(i, options.filters);
          return true;
        });
        if (options.exclusionFilters && options.exclusionFilters.length) {
          picked = picked.filter(function (i) { return !anyMatch(i, options.exclusionFilters); });
        }
        log('requestDevice 命中 ' + picked.length + '/' + all.length + ' 个接口');
        if (!picked.length) return [];
        return api('/api/authorize', { ids: picked.map(function (i) { return i.id; }) })
          .then(function () { return api('/api/devices'); })
          .then(pickAuthorized);
      }).catch(function (e) {
        stats.lastError = String(e && e.message || e);
        warn('requestDevice 失败：', stats.lastError);
        return [];
      });
    },

    forget: function () {
      return api('/api/deauthorize', { ids: [] }).then(function () { return undefined; });
    },

    onconnect: null,
    ondisconnect: null
  });

  try {
    Object.defineProperty(navigator, 'hid', {
      configurable: true,
      enumerable: true,
      get: function () { return HIDShim; },
      set: function () { /* 忽略 webapp 的意外赋值 */ }
    });
  } catch (e) {
    warn('无法定义 navigator.hid：', e);
  }

  // 页面里 118 处 window.hid = xxx 是模块引用，与 WebHID 同名；若浏览器未原生定义 window.hid，
  // 这里补一个指向 navigator.hid 的兜底读取，避免混淆导致的 undefined 报错。
  if (!('hid' in window)) {
    try { Object.defineProperty(window, 'hid', { configurable: true, get: function () { return HIDShim; } }); } catch (e) {}
  }

  /* ---------------- 事件流 ---------------- */

  var es = null;
  function connectStream() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    es = new EventSource(DAEMON + '/api/events');
    es.addEventListener('hello', function (ev) {
      var d = JSON.parse(ev.data);
      stats.daemonUp = true;
      log('守护进程已连接', JSON.stringify({ devices: (d.devices || []).length, authorized: (d.authorized || []).length }));
      (d.devices || []).forEach(remember);
      // 记录哪些接口已授权，getDevices() 之前也能收到 inputreport
      (d.authorized || []).forEach(function (id) { if (devices.get(id)) devices.get(id).__authorized = true; });
    });
    es.addEventListener('state', function (ev) {
      var d = JSON.parse(ev.data);
      stats.daemonUp = true;
      (d.devices || []).forEach(remember);
      var known = {};
      (d.devices || []).forEach(function (i) { known[i.id] = 1; });
      devices.forEach(function (dev, id) { if (!known[id]) devices.delete(id); });
    });
    es.addEventListener('device-add', function (ev) {
      var info = JSON.parse(ev.data);
      remember(info);
      var dev = devices.get(info.id);
      if (typeof HIDShim.onconnect === 'function') { try { HIDShim.onconnect({ device: dev }); } catch (e) {} }
      try { var e2 = new Event('connect'); e2.device = dev; HIDShim.dispatchEvent(e2); } catch (e) {}
      log('设备接入', info.productName);
    });
    es.addEventListener('device-remove', function (ev) {
      var info = JSON.parse(ev.data);
      var dev = devices.get(info.id);
      if (!dev) return;
      devices.delete(info.id);
      if (typeof HIDShim.ondisconnect === 'function') { try { HIDShim.ondisconnect({ device: dev }); } catch (e) {} }
      try { var e2 = new Event('disconnect'); e2.device = dev; HIDShim.dispatchEvent(e2); } catch (e) {}
      log('设备拔出', info.productName);
    });
    es.addEventListener('inputreport', function (ev) {
      var p = JSON.parse(ev.data);
      var dev = devices.get(p.id);
      if (dev) fireInput(dev, p.reportId, p.data);
    });
    es.onerror = function () { stats.daemonUp = false; };
  }
  // 调试/无头验证用：URL 带 ?shim_no_sse=1 时不挂 SSE 长连接
  // （SSE 永久 pending 会让 Chrome/Edge 的 --virtual-time-budget 无法推进，--dump-dom 卡死）。
  if (!/[?&]shim_no_sse=1/.test(location.search)) connectStream();

  /* ---------------- 诊断面（README 里说明用法） ---------------- */

  window.__DAREU_SHIM__ = {
    daemon: DAEMON,
    stats: stats,
    devices: function () { return Array.from(devices.values()); },
    authorized: function () { return HIDShim.getDevices(); },
    requestDevice: function (o) { return HIDShim.requestDevice(o); },
    report: function (id, reportId, bytes) { return api('/api/raw/inject', { id: id, reportId: reportId, data: toB64(bytes) }); },
    trace: function () { return api('/api/trace').then(function (r) { return r.trace; }); },
    // 无头自检用：关掉/重开 SSE 长连接。SSE 是永久 pending 请求，
    // Chrome 的 --virtual-time-budget 在有 pending 请求时不推进，--dump-dom 会卡住。
    stopStream: function () { if (es) { try { es.close(); } catch (e) {} es = null; } stats.daemonUp = false; return true; },
    startStream: function () { connectStream(); return true; },
    // 在真 Chrome 里跑：window.__DAREU_SHIM__.dumpCollections() → 复制 JSON 填进 hid-profiles.json
    dumpCollections: function () {
      return api('/api/all').then(function (r) {
        var out = {};
        (r.devices || []).forEach(function (d) {
          out[d.pidHex] = out[d.pidHex] || {};
          out[d.pidHex][d.collectionKey] = { role: 'real', collections: d.collections, path: d.path };
        });
        var txt = JSON.stringify(out, null, 2);
        console.log(txt);
        try { copy(txt); } catch (e) {}
        return txt;
      });
    }
  };

  log('已接管 navigator.hid →', DAEMON);
})();
