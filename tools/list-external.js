// 临时：列出 webapp 里所有外链（http/https/ws/wss）与 XMLHttpRequest 出现点
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'webapp');
const out = new Map();
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name === 'products' || e.name === 'language') continue; walk(p); continue; }
    if (!/\.(js|html|css|json|svg)$/.test(e.name)) continue;
    const s = fs.readFileSync(p, 'utf8');
    const hits = s.match(/(?:wss?|https?):\/\/[^"'`)\\\s<]{4,120}/g) || [];
    const keep = hits.filter(h => !/w3\.org|schema\.org|localhost|127\.0\.0\.1|example\.com/.test(h));
    const xhr = (s.match(/XMLHttpRequest/g) || []).length;
    if (keep.length || xhr) {
      const key = path.relative(ROOT, p).replace(/\\/g, '/');
      const set = out.get(key) || { urls: new Set(), xhr: 0 };
      keep.forEach(h => set.urls.add(h.replace(/[.,;]$/, '')));
      set.xhr += xhr;
      out.set(key, set);
    }
  }
}
walk(ROOT);
for (const [k, v] of [...out.entries()].sort()) {
  console.log(`\n${k}${v.xhr ? `  [XMLHttpRequest x${v.xhr}]` : ''}`);
  [...v.urls].sort().forEach(u => console.log('   ' + u));
}
console.log(`\n合计 ${out.size} 个文件有外链`);
