#!/usr/bin/env node
/**
 * 启动 Electron（scripts/launch-electron.js）
 *
 * 为什么要单独一个启动器：某些宿主环境（DeepSeek Harness 就是）会把 ELECTRON_RUN_AS_NODE=1
 * 注入环境，让 electron.exe 退化成纯 Node —— 那时主进程里 require('electron') 拿到的是
 * 「二进制文件路径字符串」，app/BrowserWindow 全是 undefined，启动即崩。
 * 这里显式把该变量删掉，再按 npm 包导出的路径拉起真正的 Electron。
 */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

let bin;
try {
  bin = require('electron'); // Node 里 = electron.exe 的绝对路径
} catch (e) {
  console.error('未安装 electron：npm i electron（默认源 TLS 失败时用 ' +
    '$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js）');
  process.exit(1);
}
if (typeof bin !== 'string') {
  console.error('require("electron") 没给出可执行路径，当前 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE);
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;         // 关键：否则 electron.exe 以 Node 模式启动
delete env.ELECTRON_RUN_AS_ELECTRON_APP; // 兼容其它宿主

// 第一个参数 = 应用目录，Electron 按 package.json 的 main 找 electron/main.cjs
const child = spawn(bin, [ROOT].concat(process.argv.slice(2)), { cwd: ROOT, env, stdio: 'inherit' });
child.on('exit', (code, sig) => process.exit(sig ? 1 : (code === null ? 1 : code)));
process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch (e) {} });
