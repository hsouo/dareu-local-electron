# dareu-local-electron

达尔优（DAREU）网页版驱动的**本地离线复现**：把官方那套 `webapp`（HTML + JS，靠 WebHID 与设备通信）
原封不动地跑在一个 Electron 桌面程序里，用 `node-hid` 顶替浏览器的 WebHID，
**不联网、不登录、不需要装 Chrome/Edge，双击 exe 就能改 DPI / 宏 / 灯光 / 按键映射。**

- 官方前端 `webapp/` **一个字节都没改**：所有本地化逻辑都在 `src/` 里，靠服务端注入 + 垫片完成
- 设备报文协议（14 个 JS，约 250KB）直接复用官方实现，实测与真机完成报文往返
- 出厂即离线：`fetch / XHR / WebSocket / window.open` 全部就地短路，主进程再挂一层请求防火墙
- 自带窗口与端口管理：关窗即释放端口，端口被占自动顺延，重复启动自动复用
- 打包产物 `DAREU-Driver.exe`（win32-x64，含图标与文件属性）
- **懒人入口**：[Releases](https://github.com/hsouo/dareu-local-electron/releases) 里有打好的 `DAREU-Driver-win32-x64-v1.0.0.zip`
  （解压到可写目录，插设备，双击 exe）；仍需要自备 `webapp/` 才能自己重新打包

- `webapp/` 目录是官方网页驱动的静态资源（第三方所有），本仓库**不附带也不分发**它；
  运行前需要把它放到 `webapp/` 下，见 [先决条件：获取 webapp](#先决条件获取-webapp)。其余 30 多个文件都是本项目写的。

---

## 先决条件：获取 webapp

本项目复用官方网页驱动的前端与协议代码来保证功能一致，但那部分不是我们的版权内容，
所以仓库里不带。你需要准备一个 `webapp/` 目录，里面**直接**是这些条目（不要再套一层同名子目录）：

```
webapp/
  index.html        js/            pages/          css/
  products/         language/      images/         （以及 fonts/ 等，原样即可）
```

三种拿法，任选其一：

1. **手上已经有那份目录**（比如之前从官方站点保存过、或从别的机器拷来）——直接整个目录放到项目根下的 `webapp/`
2. **从官方站点整站抓取**（站点改版时可能失效）：
   ```bash
   wget --mirror --convert-links --adjust-extension --page-requisites --no-parent -P site https://dr.dareu.com/
   # 把抓到的站点根目录内容移动到 ./webapp/
   ```
3. **浏览器手动保存**：打开官方页面 → F12 → Network 里按类型全选另存（或直接「另存为 → 网页，全部」），
   保留 `js/ pages/ css/ products/ language/ images/` 这几个目录结构

放好后自检一下（没放到位时相关检查会显示「跳过」，不会报失败）：

```bash
npm test                      # 结尾不再提示 “webapp/ 未就位”
node src/cli.js list          # 插上设备能看到设备
```

> 只支持 Windows + Chromium 系；本项目按官方前端 v1.3.26 的资源结构验证过。

---

## 快速开始

先把官方前端放到位（见上面 [先决条件：获取 webapp](#先决条件获取-webapp)），然后：

```bash
npm install            # 只有 node-hid 一个运行时依赖（自带 N-API 预编译，不需要 node-gyp）
npm run app            # Electron 窗口（推荐；等价于下面的 exe）
npm start              # 只起守护进程，然后自己用浏览器开 http://127.0.0.1:8082/
npm test               # 离线自检（不需要真机）
npm run test:shim      # 真机端到端：垫片 + node-hid 往返
npm run pack           # 打成 dist\DAREU-Driver-win32-x64\DAREU-Driver.exe
```

要求 Node ≥ 18（开发时用的是 v24）。`npm i -D electron` 只在桌面窗口/打包模式需要。
窗口里点「连接设备」→ 在列表里选中鼠标/键盘/接收器；插上设备就能用，全程不需要网络。

## 运行形态

| 方式 | 说明 | 需要 |
| --- | --- | --- |
| `DAREU-Driver.exe` | 完整桌面程序，自带 Chromium | 无 |
| `npm run app` | 同一份代码直接跑 Electron | `npm i -D electron` |
| `npm start` + 浏览器 | 只跑守护进程，用系统 Chrome/Edge 开页面 | 任一 Chromium 系浏览器 |
| `npm run app:edge` | 守护进程 + `msedge --app=` 无边框窗口（最像桌面程序的兜底） | 装过 Edge |

> `file://` 打不开：官方页面用 `fetch()` 读同目录的 JSON，本地磁盘协议会被 CORS 拦。
> `http://127.0.0.1` 是安全上下文，WebHID / fetch 都正常 —— 这也是本项目所有形态共用一个本地 HTTP 服务的原因。

---

## 架构

```
┌──────────────── Electron 窗口（exe 自带 Chromium）────────────────┐
│  webapp/index.html + pages/**  ← 官方前端，零改动                   │
│  ┌ 注入 155B ────────────────────────────────────────────────┐    │
│  │ <style> 抹掉页脚文案                                        │    │
│  │ <script src="/offline-stub.js">  离线短路 + 卡死看门狗       │    │
│  │ <script src="/hid-shim.js">      接管 navigator.hid         │    │
│  └───────────────────────────────────────────────────────────┘    │
└───────────────┬──────────────────────────────────▲────────────────┘
        HTTP POST /api/**                 SSE /api/events（inputreport / add / remove）
                │                                  │
┌───────────────▼──────────────────────────────────┴────────────────┐
│  src/server.js      静态托管 + HTTP API + 注入 + 端口管理            │
│  src/hid-service.js 设备分组 / collections 合成 / 读写与报告路由      │
│  src/hid-profiles.json  各家族集合画像（命令通道、报告长度）          │
└───────────────┬───────────────────────────────────────────────────┘
                │ node-hid（N-API，hidapi 0.15.0）
        ┌───────▼────────┐
        │  DAREU 设备     │   VID 0x260D
        └────────────────┘
```

- 渲染层与守护进程之间**只有 HTTP + SSE**，没有额外依赖（不引 ws、不引 express）
- 协议层（`js/device*.js`、`js/macro.js`…）实测零 DOM、零 jQuery、零 `window.parent`，
  所以可以被 `src/test-protocol.js` 直接塞进 `vm` 沙箱里跑 —— 这也是"前端零改动"的底气

---

## 目录结构

```
src/
  server.js          守护进程：静态托管、HTTP API、注入、端口自动分配
  hid-service.js     node-hid 封装：设备分组、collections 合成、报告收发
  hid-profiles.json  六个家族的集合画像（TG / TGHS / JM / QF / OHID / HY）
  port.js            端口探测/顺延/复用 + state/daemon.json
  paths.js           数据目录（asar 只读时自动挪到 exe 同级 dareu-state\）
  shim/hid-shim.js   WebHID 垫片（浏览器侧）
  shim/offline-stub.js  离线短路 + 卡死看门狗（浏览器侧）
  pages/login.html   401 跳 /login.html 的本地说明页
  cli.js             命令行：list / info / collections / probe / watch / port / stop / serve
  selftest.js        离线自检（67 项）
  test-shim.js       真机 E2E：在 Node 里造浏览器环境跑真垫片（20 项）
  test-protocol.js   真机协议自测：在 vm 里加载官方协议层，对真机跑只读命令
electron/main.cjs    Electron 主进程（内嵌同一个 server + 外部请求防火墙）
scripts/pack.js      打包 exe（直接复制 Electron 发行版 + 换图标/属性 + 生成 asar）
scripts/make-icon.py 生成 build/icon.png 与 icon.ico（Pillow）
scripts/zip-dist.ps1 把 dist 产物压成 release\*.zip（顺带清掉运行期状态）+ 写 .sha256
scripts/release.ps1  建 tag / Release 并上传附件（token 走 git credential fill）
tools/               真机核对与验证脚本（HID 能力、外链审计、端口释放、无头验证）
build/               图标源文件
CHANGELOG.md         版本记录
webapp/              需自备：官方网页驱动的静态资源（本仓库不附带，见「先决条件」）
```

---

## 工作原理

### 1. 注入：前端零改动

`GET /index.html` 时在第一个 `<script>` 前插入一行 `<style>` + 两行 `<script>`，
磁盘上的 `webapp/index.html` 仍是 **57921 字节**（与官方一致）。
注入的字节数由 `src/server.js` 的 `INJECT_BOTH/INJECT_HTML` 常量描述，自检按常量断言
（顶层页 155B，子页面 114B —— 子页面只需要离线桩，不需要 HID 垫片）。

页面底部原有的厂商信息文案（两行）也在这一层处理掉：语言包出网前把 `Copyright`/`Filings`
两个键的值替换成空串（只做值替换，其余字节不变），再用注入的 CSS 把对应元素藏起来；
磁盘上的语言包不动，自检里 4 条断言盯着它。

### 2. WebHID 垫片（`src/shim/hid-shim.js`）

实现官方页面用到的那几件：
`getDevices / requestDevice / forget / open / close / sendReport / sendFeatureReport / receiveFeatureReport / oninputreport / addEventListener`。

- `filters` 与 `exclusionFilters`（`vendorId/productId/serialNumber/usagePage/usage`）按规范匹配，
  `usage` 命中会遍历 `collections` —— `js/global.js` 的 5 条 `DEVICE_FILTERS` 全靠这个
- **`event.data` 是建在"长度恰好等于报告字节数"的 ArrayBuffer 上的 DataView**。不是洁癖：
  `js/device/jmdevice.js` 收包时写 `new Uint8Array(t.data.buffer)`，如果 buffer 是 Node 的共享池，协议立刻错乱。
  `test-shim.js` 有专门一条断言盯 `data.buffer.byteLength === 16`
- `HIDShim` 和每个设备对象都是**真正的 `EventTarget` 实例**。
  `Object.setPrototypeOf(普通对象, EventTarget.prototype)` 在真浏览器里会炸
  `TypeError: Illegal invocation`（官方页面正好有 `navigator.hid.addEventListener("connect", …)`）
- 没有浏览器授权弹窗：授权状态存 `state/authorized.json`（按 `vid:pid:serial` 记忆），
  `requestDevice()` 在垫片里完成同一套 filters 匹配

### 3. collections 合成（`src/hid-profiles.json`）

官方页面靠 `HIDDevice.collections` 的 `usagePage/usage` + 报告 ID 判断设备属于哪个家族，
而 hidapi 不提供 report descriptor。所以本项目按「一个物理设备（同一 USB 接口的多个集合归并）=
一个 WebHID 设备」的粒度，用 profile 合成 collections，报告长度用真机实测值填充：

```powershell
npm run caps      # tools/hid-caps.ps1：HidD_GetPreparsedData + HidP_GetCaps，长度含 Report ID 字节
```

以 TM290F 的 2.4G 接收器（`260d:1227`，FwType 2）为例，9 个 hidapi path 归并成一个设备：

| 集合 | 用途 | in / out / feature |
| --- | --- | --- |
| `0xFF02:0x02` | 匠盟命令通道 | 17 / 17 / 0（body 16B，ReportId 8） |
| `0xFF04:0x02` | feature 通道 | 0 / 0 / 8 |
| `0x0C:0x01`、`0x01:0x80`、`0xFF05:*`、`0xFF03:*` | 通知/多媒体 | in 3/2/8/8 |
| `0x01:0x02`、`0x01:0x06` | 系统独占的鼠标/键盘接口 | **绝不开启**（CreateFile err=5） |

`#shouldOpen()` 只打开 profile 认定为命令/通知/feature 的接口，把系统 HID 驱动占用的接口留着；
`#pickHandle()` 再按 `reportId` 把报文路由到正确的 path。

### 4. 读取用 5ms 轮询，而不是阻塞读

`src/hid-service.js` 的 `#startRead()` 用 `setInterval` + `hid.readTimeout(0)`。
两个原因：

- node-hid 的 `read(cb)` 在工作线程里阻塞 `ReadFile`，设备静默时 `hid.close()` 会等那个线程，
  连 `process.reallyExit()` 都走不掉（实测过进程不退出）
- **轮询间隔直接决定官方页面会不会一直转圈**：命令-应答链路（`sendReport` → 等 `inputreport`）
  的往返延迟一旦超过页面侧的等待上限，官方代码就走「与设备交互失败」分支。
  20ms 间隔在真机上稳定复现，5ms（默认，可用 `DAREU_POLL_MS` 调）同一条链路全绿

### 5. 端口生命周期

| 情况 | 行为 |
| --- | --- |
| 8082 空 | 起在 8082，写 `state/daemon.json` |
| 被**别的程序**占 | 顺延到 8083（`DAREU_PORT_RANGE`，默认 40；全占就 `listen(0)`），日志提示；垫片按 `location.port` 走，无需配置 |
| 8082 上跑的**就是本项目另一个实例** | 不起第二份（会抢同一个 HID 设备），窗口直接复用那个守护进程 |
| 关窗口 | `before-quit → server.close() → 清 daemon.json`，端口立刻归还系统 |

`DAREU_PORT=8090` 可钉死端口；CLI 与 Electron 都会通过 `state/daemon.json` + 顺扫自动找到端口。

### 6. 离线（三层）

1. **静态面**：`node tools/audit-egress.js` 扫全部前端与 `app.asar`。外部地址只剩
   `js/api/api.js` 的 baseURL、页脚一条链接、`gtag`（官方 HTML 里本来就被注释掉）和三个
   点击才触发的 `window.open`/`fetch`；没有 `sendBeacon`、`new Image()` 打点、`EventSource`、
   `@import http`、外链 `<script>/<link>/<img>`
2. **渲染层**：`offline-stub.js` 拦 `fetch / XMLHttpRequest / WebSocket / window.open`，
   非回环一律就地伪造返回（云端统一回 `{code:0,data:[],offline:true}`，与前端拦截器期望的形状一致）；
   顺带一个看门狗：页面若长时间停在加载页，弹出「重新扫描 / 返回设备列表 / 查看诊断 / 继续等待」，
   不再无限转圈
3. **主进程**：`electron/main.cjs` 给 `session.defaultSession` 挂 `webRequest.onBeforeRequest`，
   非 `127.0.0.1/localhost` 的 http(s)/ws 一律 `cancel` 并记日志。调试要联网时显式 `DAREU_ALLOW_NET=1`

因此以下云端功能在本地是空的（前端会正常降级，不会卡住）：云同步配置、游戏档案、
固件在线升级（官方前端本来也没有在线升级实现）、以及需要单独安装程序的「音乐律动」
（它连本机 `ws://localhost:8081`，本项目不含该伴侣程序，页面会提示连接失败）。

---

## 支持的设备

判定完全沿用官方前端的判据（`index.html` 里按 FwType 装配设备类）：

| FwType | 家族 | 设备类 | 传输 |
| --- | --- | --- | --- |
| 0 / 1 | TG（自研） | TgMouse / TgKeyboard | Feature Report（64B） |
| 2 / 3 | JM 匠盟 / QF 群峰 | JmMouse / JmKeyboard / Qf* | `sendReport`（16B，ReportId 8） |
| 4 / 5 | OHID / HY 合盈 | OhidKeyboard / HyKeyboard | `sendReport`（16B） |
| 6 | TG 磁轴 | TgRtKeyboard | Feature Report（64B，ReportId 0） |
| 7 | TG 接收器 | TgOhidDongle | Feature Report（ReportId 7） |

`webapp/products/` 有 187 个产品 JSON（4 位十六进制 PID 目录）。加一只没有 profile 的新设备：

1. `npm run caps` 看真机各 path 的报告长度
2. 在 `src/hid-profiles.json` 的 `families.*.collections` 或 `byPid` 里补一条画像
3. 用真机跑 `npm run test:live` 与 `npm run test:shim`
4. 如果 hidapi 长度不够描述，在真 Chrome 里打开 `http://127.0.0.1:8082/`，
   执行 `__DAREU_SHIM__.dumpCollections()`，把结果 `POST /api/collections-cache` 灌回 `state/collections-cache.json`

---

## CLI

```bash
node src/cli.js list                 # 列出已识别设备（家族/型号/FwType/集合数）
node src/cli.js info <PID|id前缀>     # 单设备详情（含命令通道与各 path 长度）
node src/cli.js collections <PID>     # 逐条打印 collections
node src/cli.js probe <PID>           # 真机只读报文探测
node src/cli.js watch 10              # 实时看 [tx]/[rx] 报文
node src/cli.js port | stop | serve   # 查端口 / 停守护进程 / 内嵌模式跑
```

守护进程在跑就走 HTTP，没跑就内嵌 `HidService`，两种模式输出一致。

## HTTP API（只监听 127.0.0.1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/devices` `/api/all` `/api/state` | 设备列表 / 全量 / 守护进程状态（含 `service/pid/port/offline`） |
| GET | `/api/events` | SSE：`hello / state / device-add / device-remove / inputreport` |
| GET | `/api/trace` | 最近 2000 条日志（含 `[tx]/[rx]`、注入、拦截） |
| POST | `/api/refresh` `/api/authorize` `/api/deauthorize` | 重新枚举、授权、撤销 |
| POST | `/api/open` `/api/close` | 打开/关闭设备 |
| POST | `/api/send-report` `/api/send-feature-report` `/api/receive-feature-report` | 收发报告 |
| POST | `/api/raw/write` `/api/raw/feature` `/api/raw/get-feature` `/api/raw/inject` | 直接按 path 操作 / 注入一条假报告 |
| POST | `/api/collections-cache` | 灌入真 Chrome 抓到的 collections |
| POST | `/api/shutdown` | 退出（会释放端口） |

---

## 测试

```bash
npm test              # 67 项离线自检：配置完整性 / 垫片源码约束 / HTTP 与注入 / 页面判据模拟 / 协议层可加载
npm run test:shim     # 20 项真机 E2E：在 Node 里造最小浏览器环境，加载真垫片，走 navigator.hid 全流程
npm run test:live     # 真机协议自测：vm 里加载官方 14 个协议脚本，对真接收器跑只读命令
npm run check         # selftest + test-shim
```

没放 `webapp/` 时，`npm test` 会把依赖官方资源的那几条记成「跳过」并打印该放的目录；
`npm run test:live` 与 `npm run pack` 会直接退出并给出提示。

`test:live` 的输出示例（`260d:1227`）：

```
14/14 协议脚本加载 OK
HidDevice 实例 = JmHidDevice  ReportId=0x8 REPORT_SIZE=16 TargetId=0
✓ GetDongleFwVersion → true      ✓ GetDeviceInfo → true (24ms)
✓ CheckActive → true             outParam: JmType=5 CID=10 MID=18
JM_WIRELESS_MAP[0x1227] 命中 → 当前配对设备 PID=0x1226
```

无头验证（不需要 GUI，也能断网）：

```powershell
npm run verify:offline   # 断 DNS + 无头 Chrome 加载页面，看有没有 Uncaught
npm run verify:app       # 断 DNS + 自动点击走完整开机链，结论写进 /api/trace
```

> 无头 Chrome 注意两点：`--dump-dom` 与 SSE 不兼容（永久 pending 请求会让虚拟时间不推进），
> 用 `?shim_no_sse=1` 关掉事件流；`--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"`
> 必须整体带引号，且**别把回环也拦掉**。

---

## 打包

```bash
npm run pack          # → dist\DAREU-Driver-win32-x64\DAREU-Driver.exe
```

`scripts/pack.js` 直接复制 `node_modules/electron/dist`、重命名 exe、写图标与文件属性、
把应用代码打成 `resources/app.asar`（`@electron/packager` 依赖去 GitHub 下载发行版，
本机取不到，所以自己拼）。图标由 `python scripts/make-icon.py` 生成（`build/icon.ico`）。
`webapp/` 没放到位时打包会直接退出（打出来也是空壳）。

自动化冒烟（跑完整开机链后自动退出，结果写 `dareu-state\smoke.json`）：

```powershell
cmd /c "set ELECTRON_RUN_AS_NODE=&& set DAREU_SMOKE_MS=42000&& DAREU-Driver.exe"
```

> 在脚本里启动 Electron 应用前必须清掉 `ELECTRON_RUN_AS_NODE`，否则 exe 会当成纯 Node 静默退出。

发布链（本仓库自己用的那套）：

```powershell
npm run zip      # scripts/zip-dist.ps1 → release\DAREU-Driver-win32-x64-v<版本>.zip + .sha256
npm run release  # scripts/release.ps1 → 打 tag、建 Release、传附件（token 取自 git credential fill）
```

> 传 Release 附件时别用 `curl --data-binary`：这台机器上 curl 8.19（直连 / HTTP 代理 / SOCKS5 三种走法都试过）
> 一律被 `uploads.github.com` 以 HTTP 400「Whoa there!」拒掉。用
> `Invoke-RestMethod -InFile` + `[Net.ServicePointManager]::Expect100Continue = $false` 就正常（127MB / 178s）。

---

## 已知限制

- **实测覆盖**：真机验证走的是匠盟（FwType 2）16 字节命令通道。自研/海思的 Feature Report 通道
  本机没有对应设备，未做真机验证；FwType 1/3/4/5/6 家族的 collections 画像来自判据推导，
  拿到真机后建议按 [加新设备](#支持的设备) 第 4 步灌一次真实 collections
- `webapp/` 里 4 个 PID（`1092/0215/F055/0082`）在 `AVAILABLE_PID_LIST` 里却没有产品 JSON，
  官方驱动同样认不出，属于上游缺失
- 「音乐律动」需要原厂那个本机服务，本项目不含（页面会提示连接失败，其余功能不受影响）
- 云同步、游戏档案、固件在线升级不可用（见 [离线](#6-离线三层)）
- 与官方桌面驱动**不能同时运行**（会抢同一个 HID 设备），官方页面本身也有这个提示
- `reference/`（可选，未纳入版本库）是压缩 JS 的美化副本，仅供阅读，花括号有丢失，不要依赖

---

## 许可与免责声明

- 本仓库只包含本项目自己编写的代码，**不含也不分发**官方网页驱动的前端与协议资源；
  `webapp/` 需要你从自己有权使用的来源获取后放入。本项目仅用于在本机与自己拥有的设备互操作、
  离线可用性验证，不用于分发或商业用途。
- Release 附件是可直接运行的成品，它的 `resources/app.asar` 里必然包含上述前端与协议脚本；
  请只当作个人本机备份使用，不要二次分发或用于商业用途。
- 修改设备配置有风险（尤其写 Flash / 校准类页面），请先用自己的设备试；本项目不提供任何保证。
- 本项目不上传任何数据；所有报文只在本机 `127.0.0.1` 与设备之间流动。
