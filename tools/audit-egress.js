#!/usr/bin/env node
/* 外发面兜底审计：找 webapp/ 里所有"不经过 fetch/XHR 也能出网"的写法，
   以及打包产物 app.asar 里是否真带上了主进程网络拦截器。
   用法: node tools/audit-egress.js [asar路径] */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'webapp');
const PATTERNS = [
  ['sendBeacon', /navigator\s*\.\s*sendBeacon/g],
  ['new Image()', /\bnew\s+Image\s*\(/g],
  ['EventSource(', /\bnew\s+EventSource\s*\(/g],
  ['WebSocket(', /\bnew\s+WebSocket\s*\(/g],
  ['<script src=', /<script[^>]{0,200}?src\s*=/gi],
  ['<link href=', /<link[^>]{0,200}?href\s*=/gi],
  ['<img src=', /<img[^>]{0,200}?src\s*=/gi],
  ['url(http', /url\(\s*['"]?https?:/gi],
  ['@import', /@import\s+['"]?https?:/gi],
  ['XMLHttpRequest', /new\s+XMLHttpRequest|jQuery\.ajax|\$\.get(?:JSON|Script)?\s*\(|\$\.post\s*\(/g],
  ['iframe src', /<iframe[^>]{0,200}?src\s*=/gi],
  ['fetch(', /\bfetch\s*\(/g],
  ['window.open', /window\s*\.\s*open\s*\(/g],
  ['external URL', /(['"(])https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])[a-z0-9.-]/gi],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|css|json|htm)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
// jQuery 只是库内部实现，不是调用点；单独统计，不刷屏
const SKIP_DETAIL = /jquery[\d.]*\.min\.js$/i;
const report = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = re.exec(src)) && hits.length < 400) {
      const line = src.slice(0, m.index).split('\n').length;
      const snippet = src.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ');
      hits.push({ line, snippet });
    }
    if (!hits.length) continue;
    if (SKIP_DETAIL.test(f) && !['fetch(', 'WebSocket(', 'EventSource(', 'external URL'].includes(name)) continue;
    const key = path.relative(ROOT, f).replace(/\\/g, '/');
    if (!report.has(key)) report.set(key, []);
    report.get(key).push({ name, count: hits.length, sample: hits.slice(0, 4) });
  }
}

console.log(`扫描 ${files.length} 个文件（webapp/）\n`);
for (const [file, items] of [...report.entries()].sort()) {
  console.log('■ ' + file);
  for (const it of items) {
    console.log(`   ${it.name.padEnd(14)} x${it.count}`);
    if (SKIP_DETAIL.test(file)) continue;
    for (const s of it.sample.slice(0, 3)) console.log(`        :${s.line}  …${s.snippet}…`.slice(0, 190));
  }
}

const asarArg = process.argv[2];
if (asarArg && fs.existsSync(asarArg)) {
  const buf = fs.readFileSync(asarArg);
  const txt = buf.toString('latin1');
  const utf = buf.toString('utf8');
  console.log('\n■ app.asar (' + (buf.length / 1048576).toFixed(1) + ' MB) 关键内容检查');
  for (const k of ['onBeforeRequest', 'DAREU_ALLOW_NET', 'offline-stub.js', 'hid-shim.js', 'readTimeout', 'window-all-closed']) {
    console.log(`   ${k.padEnd(18)} ${txt.includes(k) || utf.includes(k) ? '✓ 已打进包' : '✗ 不在包里'}`);
  }
  for (const k of ['dr.dareu.com']) {
    console.log(`   ${k.padEnd(18)} ${txt.includes(k) ? '出现（应为注释/正则）' : '未出现'}`);
  }
}
