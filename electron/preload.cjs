/**
 * dareu Electron 预加载  (electron/preload.cjs)
 *
 * 垫片是服务端注入到 index.html 的 <script src="/hid-shim.js">，运行在渲染进程主世界，
 * 所以这里不需要桥接 HID。只暴露极少量环境信息给控制台/诊断用。
 */
'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('__DAREU_ELECTRON__', {
  versions: process.versions,
  platform: `${process.platform}-${process.arch}`,
  note: 'HID 由 http://127.0.0.1:8082 守护进程（node-hid）提供；navigator.hid 由 /hid-shim.js 接管'
});
