/**
 * 数据目录解析（打包成 exe 后必须能写状态）
 *
 * 开发态：ROOT/state（跟着仓库走，方便清档）
 * 打包态：__dirname 在 resources/app.asar 里，是**只读**的，写 authorized.json 会失败
 *         → 写到你自己的数据目录：优先 DAREU_DATA_DIR（Electron 主进程会设成 userData），
 *           否则退回 exe 同级的 dareu-state/（绿色便携），再退回 ~/.dareu-local-driver/state
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

function inArchive(p) {
  const n = path.normalize(p);
  return /app\.asar([\\/]|$)/i.test(n) || /\.asar([\\/]|$)/i.test(n);
}

function dataDir() {
  if (process.env.DAREU_DATA_DIR) return process.env.DAREU_DATA_DIR;
  if (!inArchive(ROOT)) return path.join(ROOT, 'state');                 // 开发态：跟着仓库走
  if (process.env.USER_DATA_PATH) return path.join(process.env.USER_DATA_PATH, 'state'); // Electron 打包态
  try {
    const beside = path.join(path.dirname(process.execPath), 'dareu-state');
    fs.mkdirSync(beside, { recursive: true });
    // 便携目录能建就用（拷到 U 盘也能带着配对记录走）
    fs.accessSync(beside, fs.constants.W_OK);
    return beside;
  } catch { /* 落在 Program Files 之类不可写的位置 → 用用户目录 */ }
  return path.join(os.homedir(), '.dareu-local-driver', 'state');
}

function stateFile(name) { return path.join(dataDir(), name); }

function logDir() {
  if (process.env.DAREU_LOG_DIR) return process.env.DAREU_LOG_DIR;
  if (!inArchive(ROOT)) return path.join(ROOT, 'logs');
  if (process.env.USER_DATA_PATH) return path.join(process.env.USER_DATA_PATH, 'logs');
  return path.join(dataDir(), 'logs');
}

module.exports = { ROOT, dataDir, stateFile, logDir, inArchive };
