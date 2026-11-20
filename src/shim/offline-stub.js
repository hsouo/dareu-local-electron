/**
 * offline-stub.js —— 离线守护 + 「卡住可自救」垫片（由 src/server.js 注入到**每一个** html）
 *
 * 为什么需要它：webapp 里有几处云端/本机外部依赖，以及三处「静默失败」分支。
 *   1) js/api/api.js  → https://dr.dareu.com/v1/profile/*（超时 2s，401 会跳 /login.html，而仓库里没有 login.html）
 *   2) js/webservice.js → ws://localhost:8081（音乐律动伴侣 DareuAutoService，不在仓库里）
 *   3) pages/subpage/settings.html、tg/musicrhythm.html → dr.dareu.com 下载 DareuAutoService.exe / 驱动包（点击才发）
 *   4) index.html:594/599 的 `else{}` 是**空的**：匠盟接收器 GetDeviceInfo 失败、或 PID 不在 JM_WIRELESS_MAP 里，
 *      页面就永远停在 pages/loadingpage.html（那个纯 CSS 转圈页自己不会跳走）→ 用户看到的「一直转圈」
 *
 * 本文件不改 webapp 一个字节，只做两件事：
 *   A. 把所有非 127.0.0.1 的 fetch / XHR / window.open 就地短路成「本地空响应」，
 *      形状与 api.js 期望一致（`{code:0,data:[]}`，它的响应拦截器返回的是 body 本身），
 *      这样离线时不再有 2s 超时、不再有 DNS 尝试、也不会 401 → /login.html。
 *   B. 卡住看门狗：转圈超过 WATCHDOG_MS 就在页面上盖一层「重试 / 返回设备列表 / 诊断」，
 *      让死分支变成可自救的界面（不自动跳走，避免打断正常的慢速初始化）。
 *
 * 开关（URL 查询串）：?offline=0 关闭拦截；?watchdog=0 关闭看门狗。
 */
(function () {
  'use strict';

  var q = function (k) {
    try { return new URLSearchParams(location.search).get(k); } catch (e) { return null; }
  };
  var OFF_ON = q('offline') !== '0';
  var WATCH_ON = q('watchdog') !== '0';
  var WATCHDOG_MS = Math.max(3000, Number(q('watchdog_ms') || 12000) || 12000);

  // 注意 scheme 段要覆盖 ws://、wss://，否则 ws://localhost:8081 会被当成外部地址误拦
  var LOCAL_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
  var CLOUD_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:[^/]*\.)?dareu\.com/i;
  var SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

  var log = [];
  function note(kind, url, extra) {
    var it = { t: Date.now(), kind: kind, url: String(url).slice(0, 300) };
    if (extra) it.info = extra;
    log.push(it);
    if (log.length > 400) log.shift();
    try { console.log('[offline] ' + kind + ' → ' + it.url + (OFF_ON ? '（已本地短路）' : '（放行）')); } catch (e) {}
    return it;
  }

  function abs(u) {
    try { return new URL(String(u), location.href).href; } catch (e) { return String(u); }
  }
  function isExternal(u) {
    var s = abs(u);
    if (!SCHEME_RE.test(s)) return false; // data:/blob:/相对路径 → 不是外部主机
    return !LOCAL_RE.test(s);
  }

  /* ---------------- A. 网络短路 ---------------- */

  var EMPTY = { code: 0, message: 'offline-local', data: [], offline: true };
  var rawFetch = (typeof window.fetch === 'function') ? window.fetch : null;

  function synthResponse(url) {
    var body = JSON.stringify(EMPTY);
    try {
      return new Response(body, {
        status: 200, statusText: 'OK',
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-dareu-offline': '1' }
      });
    } catch (e) { return null; }
  }

  if (OFF_ON && typeof window.fetch === 'function' && !window.fetch.__dareuOffline) {
    var rawFetch = window.fetch;
    var patched = function (input, init) {
      try {
        var u = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || '';
        if (isExternal(u)) {
          note(CLOUD_RE.test(abs(u)) ? 'fetch:cloud' : 'fetch:external', abs(u));
          var r = synthResponse(u);
          if (r) return Promise.resolve(r);
          return Promise.reject(new TypeError('dareu-offline: blocked ' + u));
        }
      } catch (e) { /* 判定失败就放行，绝不让页面因垫片报错 */ }
      return rawFetch.apply(this, arguments);
    };
    patched.__dareuOffline = true;
    window.fetch = patched;
  }

  // XMLHttpRequest：只短路外部主机（api.js 用的是 fetch，这里兜住 jQuery $.ajax 之类的调用）
  if (OFF_ON && window.XMLHttpRequest && !window.XMLHttpRequest.prototype.__dareuOffline) {
    var RawXHR = window.XMLHttpRequest;
    var rawOpen = RawXHR.prototype.open;
    var rawSend = RawXHR.prototype.send;
    RawXHR.prototype.open = function (method, url) {
      this.__dareuBlocked = isExternal(url) ? abs(url) : null;
      return rawOpen.apply(this, arguments);
    };
    var fake = function (xhr, url) {
      // 用.defineProperty 伪造只读属性，够 jQuery/原生读取即可
      var text = JSON.stringify(EMPTY);
      var define = function (k, v) { try { Object.defineProperty(xhr, k, { configurable: true, get: function () { return v; } }); } catch (e) {} };
      define('readyState', 4); define('status', 200); define('statusText', 'OK');
      define('responseText', text); define('response', text); define('responseURL', url);
      define('responseXML', null);
      setTimeout(function () {
        try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) {}
        try { xhr.dispatchEvent(new Event('load')); } catch (e) {}
        try { xhr.dispatchEvent(new Event('loadend')); } catch (e) {}
      }, 0);
    };
    RawXHR.prototype.send = function () {
      if (this.__dareuBlocked) {
        note('xhr:external', this.__dareuBlocked);
        fake(this, this.__dareuBlocked);
        return;
      }
      return rawSend.apply(this, arguments);
    };
    RawXHR.prototype.__dareuOffline = true;
  }

  // ws://localhost:8081（音乐律动伴侣）保持原生：连接被拒是**即时失败**，webservice.js 只会 console.log，不会挂
  if (OFF_ON && window.WebSocket && !window.WebSocket.__dareuOffline) {
    var RawWS = window.WebSocket;
    var WS = function (url, prot) {
      if (isExternal(url)) {
        note('ws:external', abs(url));
        // 不能 Object.create(WebSocket.prototype)：readyState 等在原型上是只有 getter 的
        var dead = new EventTarget();
        dead.url = String(url); dead.readyState = 3; dead.binaryType = 'blob';
        dead.close = function () {}; dead.send = function () { throw new Error('Closed'); };
        setTimeout(function () {
          try {
            var e = new Event('error'); e.target = dead; dead.dispatchEvent(e);
            var c = new Event('close'); c.code = 1006; c.wasClean = false; dead.dispatchEvent(c);
            if (typeof dead.onerror === 'function') dead.onerror(c);
            if (typeof dead.onclose === 'function') dead.onclose(c);
          } catch (e2) {}
        }, 0);
        return dead;
      }
      return prot === undefined ? new RawWS(url) : new RawWS(url, prot);
    };
    WS.prototype = RawWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k, i) {
      try { Object.defineProperty(WS, k, { value: i, configurable: true }); } catch (e) {}
    });
    WS.__dareuOffline = true;
    window.WebSocket = WS;
  }

  if (OFF_ON && typeof window.open === 'function' && !window.open.__dareuOffline) {
    var rawOpen2 = window.open;
    var o = function (u) {
      if (u && isExternal(u)) { note('window.open:external', abs(u)); return null; }
      return rawOpen2.apply(this, arguments);
    };
    o.__dareuOffline = true;
    window.open = o;
  }

  /* ---------------- B. 卡住看门狗 ---------------- */

  var CN = {
    title: '页面停留在“加载中”',
    body: '驱动已经和设备本地通信（无需联网）。如果这里长时间转圈，通常是配对设备休眠/未开机，或该接收器的 CID/MID 不在页面内置配对表里。',
    retry: '重新扫描设备',
    back: '返回设备列表',
    diag: '查看诊断',
    close: '继续等待',
    trace: '最近通信记录',
    net: '被短路的外部请求'
  };
  function texts() {
    try {
      var L = window.parent && window.parent.language;
      if (L && (L.DeviceCommunicateFail || L.Error)) {
        return {
          title: (L.Loading || 'Loading') + ' …',
          body: [L.DeviceConnecting || '', L.DeviceCommunicateFail || ''].filter(Boolean).join(' / '),
          retry: L.Rescan || L.Retry || 'Retry',
          back: L.Back || 'Back',
          diag: L.Diagnostic || 'Diagnosis',
          close: L.Cancel || L.Close || 'Wait',
          trace: 'trace',
          net: 'network'
        };
      }
    } catch (e) {}
    return CN;
  }

  function spinning() {
    // 1) 停在 loadingpage.html（index.html 用它当「正在连接设备」遮罩，它自己不会跳走）
    if (/\/pages\/loadingpage\.html/i.test(location.pathname)) return 'loadingpage.html';
    // 2) 页面自己有个 #loadingMask（main.html 的 ShowLoading）
    try {
      var m = document.getElementById('loadingMask');
      if (m) {
        var cs = getComputedStyle(m);
        if (cs && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05) return 'loadingMask';
      }
    } catch (e) {}
    return null;
  }

  var overlay = null, shownAt = 0, since = 0;

  // 「返回设备列表」：把顶层 iframe 指回 init.html。看门狗按钮和自动兜底都用它
  function goBack() {
    var P = null;
    try { P = window.parent && window.parent !== window ? window.parent : window; } catch (e) { P = window; }
    try {
      var md5 = P.CurrentMD5 || '';
      var lang = 'cn';
      try { lang = P.localStorage.getItem('localLanguage') || 'cn'; } catch (e) {}
      var f = P.document && (P.document.getElementById('FrameMain') || P.document.getElementById('frameMain'));
      if (f) { f.src = 'pages/init.html?RDM=' + md5 + '&Lang=' + lang; hideOverlay(); return true; }
    } catch (e) {}
    try { location.reload(); } catch (e2) {}
    return false;
  }

  function showOverlay(why) {
    if (overlay) return;
    var T = texts();
    overlay = document.createElement('div');
    overlay.id = 'dareu-watchdog';
    overlay.setAttribute('style', 'position:fixed;inset:0;z-index:2147483000;background:rgba(6,10,20,.86);' +
      'color:#e6edf7;font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;display:flex;align-items:center;justify-content:center');
    var box = document.createElement('div');
    box.setAttribute('style', 'max-width:640px;width:86%;padding:22px 24px;border:1px solid #2b3a55;border-radius:12px;background:#111a2b;box-shadow:0 18px 60px rgba(0,0,0,.5)');
    var html = '<div style="font-size:16px;font-weight:600;margin-bottom:8px">' + T.title + '（' + why + '）</div>' +
      '<div style="color:#9fb0c9;margin-bottom:14px">' + T.body + '</div>' +
      '<div class="dw-btns" style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button data-a="retry" style="padding:7px 14px;border-radius:8px;border:1px solid #3a6df0;background:#1b2f5e;color:#dfe9ff;cursor:pointer">' + T.retry + '</button>' +
      '<button data-a="back" style="padding:7px 14px;border-radius:8px;border:1px solid #2b3a55;background:#182338;color:#dfe9ff;cursor:pointer">' + T.back + '</button>' +
      '<button data-a="diag" style="padding:7px 14px;border-radius:8px;border:1px solid #2b3a55;background:#182338;color:#dfe9ff;cursor:pointer">' + T.diag + '</button>' +
      '<button data-a="close" style="padding:7px 14px;border-radius:8px;border:1px solid #2b3a55;background:#182338;color:#9fb0c9;cursor:pointer">' + T.close + '</button>' +
      '</div><pre id="dw-pre" style="display:none;max-height:260px;overflow:auto;margin:14px 0 0;padding:10px;border-radius:8px;background:#0a1220;color:#a8c7fa;font-size:12px;white-space:pre-wrap"></pre>';
    box.innerHTML = html;
    overlay.appendChild(box);
    box.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-a');
      if (!a) return;
      if (overlay) overlay.__acted = true;
      var P = null;
      try { P = window.parent && window.parent !== window ? window.parent : window; } catch (e) { P = window; }
      if (a === 'close') { hideOverlay(); return; }
      if (a === 'retry') {
        try { if (typeof P.ScanDevice === 'function') { P.ScanDevice(); hideOverlay(); return; } } catch (e) {}
        try { location.reload(); } catch (e) {}
        return;
      }
      if (a === 'back') { goBack(); return; }
      if (a === 'diag') {
        var pre = box.querySelector('#dw-pre');
        if (!pre) return;
        pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
        pre.textContent = '…';
        try {
          fetch('/api/trace').then(function (r) { return r.json(); }).then(function (j) {
            var t = (j.trace || []).slice(-24).map(function (x) {
              return (x.dir || x.kind || '') + ' ' + (x.text || x.msg || JSON.stringify(x)).slice(0, 160);
            }).join('\n');
            var n = log.map(function (x) { return '[短路] ' + x.kind + ' ' + x.url; }).join('\n');
            pre.textContent = [T.trace + ':\n' + (t || '(空)'), n ? '\n' + T.net + ':\n' + n : ''].join('\n');
          }).catch(function (e) { pre.textContent = 'trace 失败: ' + e; });
        } catch (e) { pre.textContent = 'trace 不可用: ' + e; }
        return;
      }
    });
    function detach() { try { (document.body || document.documentElement).removeChild(overlay); } catch (e) {} overlay = null; }
    overlay.__detach = detach;
    try { (document.body || document.documentElement).appendChild(overlay); shownAt = Date.now(); } catch (e) { overlay = null; }
  }
  function hideOverlay() { if (overlay && overlay.__detach) overlay.__detach(); since = 0; }

  if (WATCH_ON) {
    setInterval(function () {
      var why = spinning();
      if (!why) { since = 0; return; }
      var now = Date.now();
      if (!since) since = now;
      if (overlay) {
        // 设备醒来后页面自己跳走了 → 撤掉遮罩
        if (why !== 'loadingpage.html' && spinning() == null) { hideOverlay(); return; }
        // 没人点按钮 → 再等一个阈值就自动返回设备列表，保证「永远不会一直转圈」
        if (!overlay.__acted && shownAt && now - shownAt >= WATCHDOG_MS) {
          overlay.__acted = true;
          try {
            var tip = overlay.querySelector('[data-a="back"]');
            if (tip) tip.textContent = T.back + '（已自动）';
          } catch (e) {}
          console.log('[offline] 看门狗自动返回设备列表（转圈 ' + Math.round((now - shownAt) / 1000) + 's 无人操作）');
          try {
            fetch('/api/event-log', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ verdict: { watchdogAutoBack: true, why: why, ms: now - shownAt } })
            }).catch(function () {});
          } catch (e) {}
          goBack();
        }
        return;
      }
      if (now - since >= WATCHDOG_MS) showOverlay(why);
    }, 1000);
  }

  /* ---------------- C. 自动点击模式（无头自检用，localStorage.dareu_autoclick=1 才生效） ---------------- */
  // tools/verify-app.ps1 会打开这个开关，让无头 Chrome 走完「点设备 → loading → 主页面/断开页」，
  // 把 FrameMain 的走向写进顶层 DOM，最后 stopStream() 让 --virtual-time-budget 能推进并 dump。
  var AUTO = false;
  try { AUTO = localStorage.getItem('dareu_autoclick') === '1'; } catch (e) { AUTO = false; }
  // 顶层页面带 ?autoclick=1 → 写进同源的 localStorage，iframe（init.html 由 index.html 生成 URL）才看得见
  if (q('autoclick') === '1') { AUTO = true; try { localStorage.setItem('dareu_autoclick', '1'); } catch (e) {} }
  if (q('autoclick') === '0') { AUTO = false; try { localStorage.removeItem('dareu_autoclick'); } catch (e) {} }

  function autoBox() {
    var d = document.getElementById('dareu-auto');
    if (!d) {
      d = document.createElement('div');
      d.id = 'dareu-auto';
      d.setAttribute('style', 'position:fixed;left:0;bottom:0;z-index:2147483600;max-width:44vw;max-height:30vh;overflow:auto;' +
        'background:rgba(0,0,0,.75);color:#8fd3a0;font:11px/1.4 monospace;padding:6px 8px;white-space:pre-wrap');
      (document.body || document.documentElement).appendChild(d);
    }
    return d;
  }

  if (AUTO && window.top === window) {
    var frames = [];
    var t0 = Date.now();
    var timer = setInterval(function () {
      var now = Date.now() - t0;
      var rec = { t: now, src: null, dev: false, stuck: false };
      try {
        var f = document.getElementById('frameMain') || document.getElementById('FrameMain');
        rec.src = f ? (f.getAttribute('src') || '').split('?')[0] : null;
      } catch (e) { rec.err = String(e); }
      try { rec.dev = !!window.currentDevice; } catch (e) {}
      try { rec.stuck = !!document.getElementById('dareu-watchdog') || !!(window.frames[0] && window.frames[0].document && window.frames[0].document.getElementById('dareu-watchdog')); } catch (e) {}
      // iframe 里正在跑的那个页面的真实地址（比 iframe.src 属性更实时）
      try {
        var fd = window.frames[0];
        if (fd && fd.location) rec.live = (fd.location.pathname || '').replace(/^\/+/, '');
        if (/loadingpage\.html$/i.test(rec.live || '')) rec.stuck = true;
      } catch (e) {}
      frames.push(rec);
      if (frames.length > 60) frames.shift();
      // 心跳：把「还在飞行中的请求」打出来，卡住时能直接看到是谁吊着
      try {
        var pend = performance.getEntriesByType('resource').filter(function (x) { return !x.responseEnd || x.responseEnd === 0; })
          .slice(-6).map(function (x) { return x.name.replace(/^https?:\/\/[^/]+/, '') + '@' + Math.round(x.startTime); });
        rec.pend = pend;
        console.log('[auto] t=' + now + ' src=' + rec.src + ' dev=' + rec.dev + ' pend=' + JSON.stringify(pend));
      } catch (e) {}
      try { autoBox().textContent = 'AUTO ' + JSON.stringify(frames.slice(-6)) + (rec.stuck ? '  ⚠ STUCK' : ''); } catch (e) {}
      if (now > 30000) {
        clearInterval(timer);
        var last = frames[frames.length - 1] || {};
        var where = last.live || last.src || '';
        var verdict = {
          ok: !last.stuck && /main\.html|maindisconnect\.html/i.test(where),
          reached: where, last: last, frames: frames
        };
        try {
          var d = autoBox();
          d.textContent = 'AUTO_RESULT ' + JSON.stringify(verdict);
          document.title = 'AUTO ' + (verdict.ok ? 'OK ' : 'STUCK ') + where;
        } catch (e) {}
        // 结果同时回灌守护进程（trace），无头 dump 失败也拿得到
        try {
          rawFetch.call(window, '/api/event-log', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ verdict: verdict })
          });
        } catch (e) {}
        // SSE 是永久 pending 请求，关掉它 --virtual-time-budget / --dump-dom 才能收尾
        try { if (window.__DAREU_SHIM__ && window.__DAREU_SHIM__.stopStream) window.__DAREU_SHIM__.stopStream(); } catch (e) {}
      }
    }, 1000);
  }

  if (AUTO && /\/pages\/init\.html$/i.test(location.pathname)) {
    // 一次性消费：点完就把标记清掉，别让下一次正常启动也自动点
    try { localStorage.removeItem('dareu_autoclick'); } catch (e) {}
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      try {
        var card = document.querySelector('.device');
        if (card) {
          card.click();
          try { autoBox().textContent = 'AUTO clicked device #' + card.value + ' (try ' + tries + ')'; } catch (e) {}
          clearInterval(iv);
          return;
        }
        // 首次运行没有历史设备卡片 → 点「连接设备」，让页面自己走 requestDevice
        if (tries === 2) {
          var nd = document.querySelector('.new-device');
          if (nd) { nd.click(); try { autoBox().textContent = 'AUTO clicked 连接设备 (requestDevice)'; } catch (e) {} }
        }
      } catch (e) {
        try { autoBox().textContent = 'AUTO click failed: ' + e; } catch (e2) {}
      }
      if (tries > 14) clearInterval(iv);
    }, 1200);
  }

  /* ---------------- 诊断面 ---------------- */
  window.__DAREU_OFFLINE__ = {
    intercept: OFF_ON, watchdog: WATCH_ON, watchdogMs: WATCHDOG_MS,
    log: function () { return log.slice(); },
    cleared: function () { log.length = 0; return true; },
    blockedCount: function () { return log.length; },
    spinning: spinning
  };
  if (OFF_ON || WATCH_ON) console.log('[offline] 离线短路=' + OFF_ON + ' 看门狗=' + WATCH_ON + '（' + WATCHDOG_MS + 'ms）');
})();
