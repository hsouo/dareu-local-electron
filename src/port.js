#!/usr/bin/env node
'use strict';
/**
 * 端口分配 + 守护进程发现（src/port.js）
 *
 * 规则：
 *   1) 首选端口 = env DAREU_PORT 或 8082。
 *   2) 首选端口上如果跑的**就是本项目的守护进程**（/api/state 带 service 标记），
 *      绝不起第二个 —— 两个进程会抢同一个 HID 设备。此时 scanListen() 抛
 *      AlreadyRunningError，主入口据此提示"直接用现有地址"并以 0 退出。
 *   3) 端口被别的程序占了 → 在 preferred+1 .. preferred+range 里顺延找空闲端口，
 *      全被占就用内核分配的临时端口（listen 0）。
 *   4) 守护进程把实际端口写进 state/daemon.json；CLI / 测试脚本用 discover() 找到它，
 *      所以端口换了也不需要告诉任何人。
 *
 * 只做端口的事，不碰 HID。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// 打包进 asar 后 ROOT 只读，端口文件要写到可写数据目录（见 src/paths.js）
const { stateFile } = require('./paths.js');
const portFile = () => stateFile('daemon.json');

/** /api/state 里的身份标记，用来区分"我们的守护进程"和"碰巧占着端口的别的程序" */
const SERVICE = 'dareu-local-driver';

const DEFAULT_PORT = Number(process.env.DAREU_PORT || 8082);
const PORT_RANGE = Math.max(0, Number(process.env.DAREU_PORT_RANGE || 40));

class AlreadyRunningError extends Error {
  constructor(port, info) {
    super(`已经有一个达尔优守护进程在 127.0.0.1:${port} 上运行`);
    this.code = 'DAREU_ALREADY_RUNNING';
    this.port = port;
    this.info = info || null;
  }
}

/* ---------------- 探测 ---------------- */

/** GET /api/state，拿不到就返回 null（端口空着、或是别的程序、或超时） */
function probe(host, port, timeoutMs = 350) {
  return new Promise((resolve) => {
    if (!(port > 0 && port < 65536)) return resolve(null);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({ host, port, path: '/api/state', timeout: timeoutMs }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 400000) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          done(j && j.service === SERVICE ? j : null);
        } catch (e) { done(null); }
      });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
  });
}

/** 一次 listen 尝试，失败就 reject（可重复用在同一个 server 上） */
function listenOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const ok = () => { server.removeListener('error', err); resolve(server.address() ? server.address().port : port); };
    const err = (e) => { server.removeListener('listening', ok); reject(e); };
    server.once('listening', ok);
    server.once('error', err);
    try { server.listen(port, host); } catch (e) { server.removeListener('listening', ok); server.removeListener('error', err); reject(e); }
  });
}

const OCCUPY = new Set(['EADDRINUSE', 'EACCES']);

/**
 * 按上面的规则把 server 挂起来。
 * @returns {Promise<{port:number, note?:string, moved?:boolean}>}
 */
async function scanListen(server, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const preferred = opts.port === undefined || opts.port === null ? DEFAULT_PORT : Number(opts.port);
  const range = opts.range === undefined ? PORT_RANGE : Number(opts.range);
  const autoPort = opts.autoPort !== false;

  // 显式要 0（内核随机端口，selftest 用）就别折腾了
  if (preferred === 0) return { port: await listenOnce(server, host, 0) };

  try {
    return { port: await listenOnce(server, host, preferred) };
  } catch (e) {
    if (!OCCUPY.has(e.code)) throw e;
    const mine = await probe(host, preferred);
    if (mine) throw new AlreadyRunningError(preferred, mine);
    if (!autoPort) throw e;

    const blocked = [preferred];
    for (let p = preferred + 1; p <= preferred + Math.max(range, 0); p++) {
      try {
        const got = await listenOnce(server, host, p);
        return { port: got, moved: true, note: `端口 ${blocked.join('/')} 被占用，已改用 ${got}` };
      } catch (e2) {
        if (!OCCUPY.has(e2.code)) throw e2;
        blocked.push(p);
        const also = await probe(host, p);          // 中途撞见自己的守护进程也算"已在运行"
        if (also) throw new AlreadyRunningError(p, also);
      }
    }
    const got = await listenOnce(server, host, 0);
    return { port: got, moved: true, note: `${blocked.length} 个候选端口都被占用，改用临时端口 ${got}` };
  }
}

/* ---------------- state/daemon.json ---------------- */

function readPortFile() {
  try { return JSON.parse(fs.readFileSync(portFile(), 'utf8')); } catch (e) { return null; }
}
function writePortFile(info) {
  try {
    fs.mkdirSync(path.dirname(portFile()), { recursive: true });
    fs.writeFileSync(portFile(), JSON.stringify(info, null, 2));
    return true;
  } catch (e) { return false; }
}
/** 只删自己写的那份（端口对得上才删），避免误删别人的 */
function clearPortFile(port) {
  const j = readPortFile();
  if (!j) return false;
  if (port !== undefined && j.port !== port) return false;
  try { fs.unlinkSync(portFile()); return true; } catch (e) { return false; }
}

/** 找到正在跑的守护进程：env → port 文件 → 顺扫一段端口 */
async function discover(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const preferred = opts.preferred === undefined ? DEFAULT_PORT : Number(opts.preferred);
  const range = opts.range === undefined ? PORT_RANGE : Number(opts.range);
  const timeoutMs = opts.timeoutMs || 250;

  const order = [];
  if (process.env.DAREU_PORT) order.push(Number(process.env.DAREU_PORT));
  const f = readPortFile();
  if (f && f.port) order.push(Number(f.port));
  for (let p = preferred; p <= preferred + Math.max(range, 0); p++) order.push(p);

  const seen = new Set();
  for (const port of order) {
    if (!port || seen.has(port)) continue;
    seen.add(port);
    const info = await probe(host, port, timeoutMs);
    if (info) return { port, host, info };
  }
  return null;
}

module.exports = {
  SERVICE, ROOT, PORT_FILE: portFile(), DEFAULT_PORT, PORT_RANGE,
  AlreadyRunningError, probe, listenOnce, scanListen, discover,
  readPortFile, writePortFile, clearPortFile
};
