# 更新记录

## v1.0.0

首个发布。

### 运行方式

- `DAREU-Driver.exe`（Electron 37.2.0 + node-hid 3.4.0，win32-x64）：双击即用，自带窗口，不需要系统浏览器
- 也可以 `npm install && npm start`（守护进程 + 浏览器）或 `npm run app`（源码态 Electron）

### 核心行为

- 官方前端 `webapp/` 零改动：运行时只注入 155 字节（HID 垫片 + 离线桩 + 页脚隐藏样式）
- `node-hid` 顶替 WebHID：设备按物理实体分组、按 HIDP Caps 合成 `collections`、按 reportId 路由到具体接口、输入报告 5ms 轮询
- 完全离线：渲染层短路 `fetch / XMLHttpRequest / WebSocket / window.open`，主进程再挂一层 `webRequest` 防火墙；关窗即释放端口，端口被占自动顺延，重复启动自动复用
- 打包产物带图标与文件属性（`scripts/pack.js`，`@electron/asar`），zip 脚本 `scripts/zip-dist.ps1`

### 实测

- 自检 67 项（无 `webapp/` 时 49 通过 + 14 跳过）、真机垫片端到端 20 项、真机协议只读往返通过
- 打包版断网冒烟：`pages/init.html → pages/main.html`，无看门狗、无挂起请求
- 实测机型：TM290F 2.4G 接收器 `260d:1227`（匠盟 FwType 2，16 字节命令通道）+ 其配对鼠标 `0x1226`

### 未验证

- 自研 / 海思的 Feature Report 通道（本机无对应设备）
- FwType 1/3/4/5/6 家族的 collections 画像（由页面判据推导，拿到真机后建议灌一次真实 collections）

### 说明

这是非官方项目，用途限于在本机与自己拥有的设备互操作以及离线可用性验证。
发布包内的 `resources/app.asar` 含官方网页驱动的前端与协议脚本，请仅个人本机使用，不要二次分发。
