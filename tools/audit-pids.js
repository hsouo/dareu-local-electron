// 临时审计：JM_WIRELESS_MAP 里所有 PID（接收器 + 配对键鼠）在 products/ 是否有 JSON
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const g = fs.readFileSync(path.join(ROOT, 'webapp/js/global.js'), 'utf8');
const m = g.match(/JM_WIRELESS_MAP\s*=\s*/);
if (!m) { console.log('没找到 JM_WIRELESS_MAP'); process.exit(1); }
// 从赋值处开始做括号配平截取数组字面量
let i = g.indexOf('[', m.index + m[0].length), depth = 0, end = -1;
for (let j = i; j < g.length; j++) {
  const c = g[j];
  if (c === '[') depth++;
  else if (c === ']') { depth--; if (depth === 0) { end = j; break; } }
}
const lit = g.slice(i, end + 1);
const map = vm.runInNewContext('(' + lit + ')');
const have = new Set(fs.readdirSync(path.join(ROOT, 'webapp/products')));
const hex = p => Number(p).toString(16).padStart(4, '0');   // products/ 目录名是 4 位十六进制 PID
const acc = new Map();
for (const e of map) {
  acc.set(e.PID, acc.get(e.PID) || { role: new Set(), pairs: 0 });
  acc.get(e.PID).role.add('dongle');
  for (const p of (e.PairInfo || [])) {
    acc.set(p.PID, acc.get(p.PID) || { role: new Set(), pairs: 0 });
    acc.get(p.PID).role.add('pair');
    acc.get(p.PID).pairs++;
  }
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('PID', 8), pad('hex', 7), pad('角色', 14), pad('products/有', 10), '条目');
let miss = 0;
for (const [pid, v] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
  const dir = hex(pid);
  const ok = have.has(dir) && fs.existsSync(path.join(ROOT, 'webapp/products', dir, dir + '.json'));
  if (!ok) miss++;
  console.log(pad(pid, 8), pad('0x' + pid.toString(16), 7), pad([...v.role].join('+'), 14), pad(ok ? '✓' : '✗ 缺失', 10), v.pairs);
}
console.log(`\nJM_WIRELESS_MAP：${map.length} 个接收器条目，涉及 ${acc.size} 个 PID，缺产品 JSON ${miss} 个`);
// 顺带：products/ 目录数 vs AVAILABLE_PID_LIST
const avail = g.match(/AVAILABLE_PID_LIST\s*=\s*\[([\s\S]{0,20000}?)\]/);
if (avail) {
  const list = vm.runInNewContext('[' + avail[1] + ']');
  const missing = list.filter(p => !have.has(hex(p)));
  console.log(`AVAILABLE_PID_LIST ${list.length} 个 PID，products/ 缺 ${missing.length} 个：${missing.slice(0, 20).join(',')}`);
}
console.log('products/ 目录数 =', have.size);
