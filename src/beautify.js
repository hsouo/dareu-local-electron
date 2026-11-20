// src/beautify.js —— 把 webapp/js 里压缩过的协议层格式化成可读副本，输出到 reference/
// 仅用于阅读与逆向，运行时不参与。用法: node src/beautify.js [源目录] [输出目录]
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.resolve(process.argv[2] || path.join(root, 'webapp', 'js'));
const outDir = path.resolve(process.argv[3] || path.join(root, 'reference'));

// 极简 JS 格式化器：在语句/块边界插入换行，保证缩进不破坏语义（字符串/模板/正则/注释内不动）
function format(code) {
  let out = '';
  let depth = 0;
  let i = 0;
  const n = code.length;
  let prevMeaning = '';            // 上一个有意义的字符
  const nl = (d) => { out = out.replace(/[ \t]+$/, ''); out += '\n' + '  '.repeat(Math.max(0, d)); };

  while (i < n) {
    const c = code[i];

    // 注释
    if (c === '/' && code[i + 1] === '/') {
      const e = code.indexOf('\n', i); const stop = e < 0 ? n : e;
      out += code.slice(i, stop); i = stop; continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const e = code.indexOf('*/', i + 2); const stop = e < 0 ? n : e + 2;
      out += code.slice(i, stop); i = stop; continue;
    }
    // 字符串 / 模板
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) { if (code[j] === '\\') { j += 2; continue; } if (code[j] === c) { j++; break; } j++; }
      out += code.slice(i, j); i = j; prevMeaning = 'x'; continue;
    }
    // 正则字面量（粗略：上一个有意义字符允许出现正则时才当正则处理）
    if (c === '/' && /[=(,:[!&|?{};+\-*%~^<>]|return|typeof|case|in|of|new|delete|void/.test(out.slice(-24).replace(/\s+$/, '').slice(-12) || '')) {
      let j = i + 1, cls = false;
      while (j < n) {
        const d = code[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') cls = true; else if (d === ']') cls = false;
        else if (d === '/' && !cls) { j++; while (j < n && /[gimsuyd]/.test(code[j])) j++; break; }
        else if (d === '\n') break;
        j++;
      }
      out += code.slice(i, j); i = j; prevMeaning = 'x'; continue;
    }

    if (c === '{') { depth++; nl(depth); out += ''; i++; prevMeaning = '{'; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); nl(depth); out += '}'; i++; prevMeaning = '}'; continue; }
    if (c === ';') { out += ';'; i++; nl(depth); prevMeaning = ';'; continue; }
    if (c === ',' && prevMeaning !== ')') {
      out += ','; i++;
      // 参数列表里的逗号不换行，只在对象/数组字面量元素很多时换行（保守：不换）
      continue;
    }
    if (/\s/.test(c)) {
      // 记录存在空白；若省略会把两个词法字符粘成一个记号，则保留一个空格
      let j = i; while (j < n && /\s/.test(code[j])) j++;
      const next = code[j];
      const needSpace = out.length > 0 && next !== undefined && /[\w$.\-+]/.test(out[out.length - 1]) && /[\w$.\-+]/.test(next)
        && !(/^[.]/.test(next) && /[\d]/.test(out[out.length - 1]));
      if (needSpace) out += ' ';
      i = j; continue;
    }
    out += c; i++; prevMeaning = c;
  }
  return out.replace(/\n{3,}/g, '\n\n') + '\n';
}

function walk(dir, list = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, list);
    else if (e.name.endsWith('.js')) list.push(p);
  }
  return list;
}

let count = 0;
for (const f of walk(srcDir)) {
  const rel = path.relative(srcDir, f);
  if (/jquery/.test(rel)) continue;                 // 第三方库跳过
  const raw = fs.readFileSync(f, 'utf8');
  const pretty = format(raw);
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, `/* 由 webapp/js/${rel.replace(/\\/g, '/')} 格式化而来（源文件为压缩版，运行时仍使用源文件） */\n` + pretty);
  count++;
  console.log(`  ${(rel + '                            ').slice(0, 34)} ${(raw.length / 1024).toFixed(0)}KB -> ${(pretty.length / 1024).toFixed(0)}KB`);
}
console.log(`\n格式化完成: ${count} 个文件 -> ${path.relative(root, dstRoot())}`);
function dstRoot() { return outDir; }
