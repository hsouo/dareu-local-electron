/**
 * dareu Electron 主进程  (electron/main.cjs)
 *
 * 方案 2 的「打包成桌面程序」形态：
 *  - 主进程内嵌守护进程（src/server.js），不需要另开终端
 *  - 同一颗 node-hid N-API 预编译二进制：Electron 37 = Node 22 ABI，node-hid 3.4.0 直接命中
 *    node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4-x64.node，**无需 electron-rebuild**
 *  - 渲染进程加载 http://127.0.0.1:PORT/（webapp + /hid-shim.js），协议层 js/device/**.js 零改动
 *  - Electron 41 才有可用的 HIDDevice.collections（且依赖 dvhid_get_device（PR #49512），
 *    Electron 36–40 枚举得到但读不到 collections），所以这里不碰 Electron 内建 WebHID，
 *    始终走 node-hid + 垫片。详见 README「为什么不用 Electron 内建 WebHID」。
 *
 * 依赖 electron 未安装时不需要它：`npm start` + Edge/Chrome --app 是不依赖 Electron 的等价路径。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
let electron;
try {
  electron = require('electron');
} catch (e) {
  console.error('[electron] 未安装 electron 模块。请先 `npm i electron`，或改用：npm start && msedge --app=http://127.0.0.1:8082/');
  process.exit(1);
}

const { app, BrowserWindow, Menu, shell, session } = electron;
const { createServer } = require(path.join(__dirname, '..', 'src', 'server.js'));
const Port = require(path.join(__dirname, '..', 'src', 'port.js'));
const Paths = require(path.join(__dirname, '..', 'src', 'paths.js'));

const ROOT = path.join(__dirname, '..');
// 打包成 asar 后 ROOT 是只读的，日志/状态都要写到可写目录（paths.js 里按运行形态挑）
const LOG_FILE = path.join(Paths.logDir(), 'electron.log');
let server = null;
let win = null;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* 日志失败不影响主流程 */ }
  console.log(...args);
}

// Electron 的 userData 目录名会带上 productName，顺手改个干净的名字
app.setName('dareu-local-driver');
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { if (server) server.close(); } catch (e) {} });

async function createWindow(url) {
  // 页面自己写死了 #frameMain{height:830px; min-width:1200px}（webapp/css/framestyle.css:3-9），
  // 版权/备案两块藏掉之后整页高度就是 830。这里用 useContentSize 直接指定「网页可视区」，
  // 免得标题栏/DPI 把高度吃掉导致出现滚动条（之前 1440x900 外框时可视区只有 ~869）。
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    minWidth: 1240,
    minHeight: 860,
    title: 'DAREU 本地驱动 (node-hid 垫片)',
    autoHideMenuBar: true,
    backgroundColor: '#0b1120',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 渲染层只需要 navigator.hid（被垫片接管）+ fetch/SSE
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);

  // 外链交给系统浏览器；产品页里的 api.dr.dareu.com 请求保持原样（离线时 webapp 自行降级）
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (e, code, desc, failingUrl) => {
    log('did-fail-load', code, desc, failingUrl);
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2 || /hid-shim|hid-service|HID/i.test(message)) log('[renderer]', message);
  });

  await win.loadURL(url);
  win.setTitle(`DAREU 本地驱动 — ${url}`);
  if (process.env.DAREU_OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  // 冒烟自检：DAREU_SMOKE_MS=38000 → 自动点第一台设备，跑完初始化链后把结论写日志并退出
  // 下限 34s：垫片里的 AUTO 在第 30s 才下结论（设备睡着时命令重试要十几秒），别抢在它前面
  const smoke = Number(process.env.DAREU_SMOKE_MS || 0);
  if (smoke > 0) {
    const wait = Math.max(smoke, 34000);
    const t0 = Date.now();
    setTimeout(async () => {
      const rep = { ms: Date.now() - t0, url, port: server ? server.port : (win ? 'reused' : '?') };
      try {
        rep.state = await win.webContents.executeJavaScript(
          `(function(){var f=document.getElementById('frameMain');return JSON.stringify({
             frame: f? f.getAttribute('src'):null,
             live: (function(){try{return f&&f.contentDocument&&f.contentDocument.location.pathname}catch(e){return null}})(),
             dev: !!window.currentDevice,
             auto: (document.getElementById('dareu-auto')||{}).textContent||null,
             watchdog: !!document.getElementById('dareu-watchdog') || !!(f&&f.contentDocument&&f.contentDocument.getElementById('dareu-watchdog')),
             title: document.title
           });})()`
        ).then((s) => JSON.parse(s));
      } catch (e) { rep.err = e.message; }
      try { rep.devices = server ? server.svc.publicList().length : -1; } catch (e) {}
      // AUTO_RESULT 是页面里那套完整判据（含「有没有卡在 loadingpage / 看门狗有没有盖遮罩」），优先信它
      let ok = false, verdict = null;
      try {
        const m = /AUTO_RESULT (\{.*\})/.exec((rep.state && rep.state.auto) || '');
        if (m) { verdict = JSON.parse(m[1]); ok = !!verdict.ok; }
      } catch (e) {}
      if (!verdict) {
        const where = (rep.state && (rep.state.live || rep.state.frame)) || '';
        ok = !!rep.state && /main\.html|maindisconnect\.html/i.test(where) && !rep.state.watchdog;
      }
      rep.ok = ok;
      rep.reached = verdict ? verdict.reached : ((rep.state && (rep.state.live || rep.state.frame)) || null);
      if (verdict) { rep.frames = verdict.frames; delete verdict.frames; rep.verdict = verdict; }
      if (rep.state) { rep.frame = rep.state.frame; rep.watchdog = rep.state.watchdog; }
      delete rep.state;
      log('SMOKE ' + JSON.stringify(rep));
      try { fs.writeFileSync(path.join(Paths.dataDir(), 'smoke.json'), JSON.stringify(rep, null, 2)); } catch (e) {}
      app.quit();
    }, wait);
  }
}

async function main() {
  const got = app.requestSingleInstanceLock();
  if (!got) { app.quit(); return; }

  await app.whenReady();
  // 断网保证：除了本机，任何外部主机（dr.dareu.com / beian / 下载…）的请求一律就地取消。
  // 页面侧还有 src/shim/offline-stub.js 做同样的事（并回本地空响应），这里再兜一层：
  // 渲染层就算绕过垫片也出不去。想联网调试：DAREU_ALLOW_NET=1
  if (!process.env.DAREU_ALLOW_NET) {
    try {
      const ses = session.defaultSession;
      const allow = (u) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(u) || !/^https?:/i.test(u);
      ses.webRequest.onBeforeRequest({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
        if (allow(details.url)) return cb({});
        log('已拦截外部请求', details.url.slice(0, 120));
        cb({ cancel: true });
      });
    } catch (e) { log('webRequest 拦截器装不上（不影响离线垫片）:', e.message); }
  }
  // 让 localStorage（webapp 有 61 处）落在项目内，便于打包与清档
  try { session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'hid')); } catch (e) {}

  server = createServer({ log });
  let url;
  try {
    const { port, note } = await server.start();
    if (note) log('端口提示', note);
    url = `http://127.0.0.1:${port}/`;
    Port.writePortFile({ service: Port.SERVICE, host: '127.0.0.1', port, url, pid: process.pid, startedAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof Port.AlreadyRunningError) {
      // 命令行已经起了守护进程：窗口直接连它，别再开第二份（会抢同一个 HID 设备）
      log(`复用已在运行的守护进程 http://127.0.0.1:${e.port}/`);
      try { server.svc.dispose(); } catch (e2) {}
      server = null;
      url = `http://127.0.0.1:${e.port}/`;
    } else throw e;
  }
  log('守护进程监听', url);
  await createWindow(process.env.DAREU_SMOKE_MS ? url + '?autoclick=1&offline=1&watchdog=1' : url);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

main().catch((e) => { log('启动失败', e && e.stack || String(e)); process.exit(1); });
