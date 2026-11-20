#!/usr/bin/env node
/**
 * 打包成独立 exe（离线自组装版）
 *
 *   npm run pack        →  dist\DAREU-Driver-win32-x64\DAREU-Driver.exe（绿色免安装，双击即用）
 *
 * 为什么不用 @electron/packager 直接跑：它内部要 @electron/get 去 GitHub 取 SHASUMS256.txt，
 * 这台机器到 github.com 是 TLS 失败（连 npm 装 electron 时都一样），会 `TypeError: fetch failed`。
 * 这里完全离线：直接把 node_modules/electron/dist 里已经解好的运行时拷成应用外壳，
 * 再用 @electron/asar 把我们的代码打成 resources/app.asar（原生 .node 解包到 app.asar.unpacked）。
 *
 * 产物结构：
 *   DAREU-Driver-win32-x64/
 *     DAREU-Driver.exe          ← Electron 主程序（改了名字）
 *     *.dll / locales/ …        ← Electron 运行时（自带 Chromium，不需要系统浏览器）
 *     resources/app.asar        ← src/ + electron/ + webapp/（原厂页面，零改动）+ node-hid
 *     resources/app.asar.unpacked/prebuilds/…node   ← Windows 只能加载真实文件里的原生模块
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs').promises;

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = process.env.DAREU_EXE_NAME || 'DAREU-Driver';
const STAGE = path.join(DIST, `${NAME}-win32-x64`);
const APP_FILES = ['package.json', 'src', 'electron', 'webapp'];
const APP_MODULES = ['node-hid', 'pkg-prebuilds'];

// 官方前端不随仓库分发；没放到位就别打包（打出来也是空壳）
if (!fs.existsSync(path.join(ROOT, 'webapp', 'index.html'))) {
  console.error('打包中止：webapp/index.html 不存在。');
  console.error('官方网页驱动的静态资源不分发在本仓库里 —— 请把你机器上那份 web_driver 的内容');
  console.error(`（index.html / js / pages / css / products / language / images）放到：${path.join(ROOT, 'webapp')}`);
  console.error('然后再跑 npm run pack。详见 README 的「获取 webapp」。');
  process.exit(2);
}

function log(...a) { console.log(a.join(' ')); }

/**
 * 用 rcedit 换掉 Electron 默认图标 + 写文件属性（版本、产品名、版权）。
 * rcedit 是 npm 包里自带的 exe，纯本地，不联网。失败不影响产物。
 */
function brandExe(exePath) {
  const bin = ['rcedit-x64.exe', 'rcedit.exe']
    .map((n) => path.join(ROOT, 'node_modules', 'rcedit', 'bin', n))
    .find((p) => fs.existsSync(p));
  const ico = path.join(ROOT, 'build', 'icon.ico');
  if (!bin) { log('  （没装 rcedit，跳过换图标：npm i -D rcedit）'); return; }
  const { spawnSync } = require('node:child_process');
  const args = [exePath];
  if (fs.existsSync(ico)) args.push('--set-icon', ico);
  const vs = {
    ProductName: 'DAREU 本地驱动',
    FileDescription: '达尔优网页驱动本地复现版（node-hid 垫片，离线可用）',
    CompanyName: '本地复现版 · 非达尔优官方',
    LegalCopyright: '非官方本地复现 · 仅供本机设备调试',
    OriginalFilename: path.basename(exePath),
    InternalName: 'dareu-local-driver'
  };
  for (const [k, v] of Object.entries(vs)) args.push('--set-version-string', k, v);
  args.push('--set-file-version', '1.0.0', '--set-product-version', '1.0.0.0');
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status === 0) log('  已换图标与文件属性' + (fs.existsSync(ico) ? '' : '（无 ico）'));
  else log('  换图标失败（不影响使用）：' + ((r.stderr || r.stdout || '') + '').trim().slice(0, 200));
}

async function copyTree(src, dest, filter) {
  const st = await fsp.stat(src);
  if (!st.isDirectory()) {                     // 单个文件（比如 package.json）
    if (filter && !filter(src)) return;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    return;
  }
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) {
      if (filter && !filter(s)) continue;
      if (/(^|[\\/])(logs|state|\.git|node_modules)$/i.test(s) && s !== src) continue;
      await copyTree(s, d, filter);
    } else {
      if (filter && !filter(s)) continue;
      if (/\.log$/i.test(e.name)) continue;
      await fsp.copyFile(s, d);
    }
  }
}

function dirSize(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return n;
}

async function main() {
  // 1) Electron 运行时（npm i electron 时已经解压好）
  const distDir = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(distDir, 'electron.exe'))) {
    log('缺少 node_modules/electron/dist。装 Electron（默认源 TLS 失败时用镜像）：');
    log('  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm i -O electron@37.2.0');
    log('  cd node_modules\\electron; $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node install.js');
    process.exit(1);
  }
  const version = require('electron/package.json').version;

  // 2) 清场重拷外壳
  log('打包中… Electron ' + version);
  await fsp.rm(STAGE, { recursive: true, force: true });
  await fsp.mkdir(STAGE, { recursive: true });
  await copyTree(distDir, STAGE, (p) => !/[\\/](resources)$/i.test(p));   // resources 自己拼
  const exe = path.join(STAGE, NAME + '.exe');
  await fsp.rename(path.join(STAGE, 'electron.exe'), exe);
  brandExe(exe);
  await fsp.mkdir(path.join(STAGE, 'resources'), { recursive: true });
  // default_app.asar 是 Electron 的「没有应用时」兜底页，删掉免得混淆
  await fsp.rm(path.join(STAGE, 'resources', 'default_app.asar'), { force: true });
  // 原版 electron.exe 的 PDB/快照之类留着无妨，这里只清掉明显没用的
  for (const junk of ['LICENSES.chromium.html']) { /* 保留：合规声明 */ void junk; }

  // 3) 拼应用内容到临时目录，再打成 asar
  const appStage = path.join(DIST, '_app-stage');
  await fsp.rm(appStage, { recursive: true, force: true });
  await fsp.mkdir(appStage, { recursive: true });
  for (const rel of APP_FILES) await copyTree(path.join(ROOT, rel), path.join(appStage, rel));
  await fsp.mkdir(path.join(appStage, 'node_modules'), { recursive: true });
  for (const m of APP_MODULES) {
    const s = path.join(ROOT, 'node_modules', m);
    if (!fs.existsSync(s)) { log('  ! 缺少依赖 ' + m); continue; }
    await copyTree(s, path.join(appStage, 'node_modules', m));
  }
  // state/ 是运行时可写目录，asar 里只读；打包时留空目录即可（paths.js 会挑可写位置）
  const appJson = JSON.parse(await fsp.readFile(path.join(appStage, 'package.json'), 'utf8'));
  appJson.main = 'electron/main.cjs';
  appJson.productName = appJson.productName || NAME;
  await fsp.writeFile(path.join(appStage, 'package.json'), JSON.stringify(appJson, null, 2));

  let asarApi;
  try { asarApi = require('@electron/asar'); } catch (e) { asarApi = null; }
  if (asarApi) {
    await asarApi.createPackageWithOptions(appStage, path.join(STAGE, 'resources', 'app.asar'), {
      // 原生模块与预编译目录必须留在真实文件系统里
      unpack: '**/*.node',
      unpackDir: '**/prebuilds'
    });
    await fsp.rm(appStage, { recursive: true, force: true });
  } else {
    log('  没找到 @electron/asar，退化成目录形式 resources/app/');
    await fsp.rename(appStage, path.join(STAGE, 'resources', 'app'));
  }

  // 4) 使用说明（放 exe 旁边，双击的人一眼看得到）
  await fsp.writeFile(path.join(STAGE, '使用说明.txt'),
`${appJson.productName || NAME} —— 达尔优网页驱动的本地复现版（离线）

双击 DAREU-Driver.exe 即可，不需要联网，也不需要装浏览器：
程序自带 Chromium 窗口 + 本机 node-hid 设备通道（原厂网页驱动的页面与协议层原样复用）。

· 打开后点“连接设备”，选你的接收器/鼠标/键盘
· 设备请先在系统里插好；2.4G 设备要保证配对端已唤醒（挪一下鼠标）
· 配对记录等状态写在 %APPDATA%\\dareu-local-driver\\state
· 云端功能（游戏配置列表、固件下载、音乐律动伴侣）依赖 dr.dareu.com / DareuAutoService，
  本地版本会把这些请求就地短路成空数据，功能不可用但不会卡住
· 本工具非达尔优官方程序，仅供自用调试
`, 'utf8');

  const size = dirSize(STAGE);
  log('完成');
  log('  主程序 ' + exe + '  (' + (fs.statSync(exe).size / 1024 / 1024).toFixed(1) + 'MB)');
  log('  目录合计 ' + (size / 1024 / 1024).toFixed(1) + 'MB');
  log('  双击运行（离线可用，自带窗口，不需要系统浏览器）');
  log('  自动化冒烟： set DAREU_SMOKE_MS=40000 && "' + NAME + '.exe"  （结果写 dareu-state\\smoke.json）');
}

main().catch((e) => { console.error('打包失败: ' + (e && e.stack || e)); process.exit(1); });
