// src/hid-service.js
// HID 服务：用 node-hid(hidapi) 复刻 Chrome WebHID 的设备模型，供 webapp 的协议层原样调用。
//
// 需要复刻的 WebHID 语义（webapp 实际用到的全部表面）：
//   navigator.hid.getDevices() / requestDevice(filters) / addEventListener('connect'|'disconnect')
//   HIDDevice: vendorId productId productName serialNumber collections[] opened
//              open() close() sendReport(id,data) sendFeatureReport(id,data) receiveFeatureReport(id)
//              oninputreport = ({device, reportId, data: DataView})
//
// 两个必须处理的差异：
//  1) hidapi 在 Windows 上按“顶层集合”枚举出多个 path，而 Chrome 把一个物理设备的多个
//     HID 接口合并成一个 HIDDevice，collections 是合并后的集合列表。→ 这里做同样的分组。
//  2) hidapi 不暴露 Report Descriptor，拿不到真实 collections。→ 用 hid-profiles.json 按
//     FwType 家族合成；如抓到 Chrome 真实数据（README 有抓取脚本），由 collections-cache 覆盖。

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const HID = require('node-hid');

const ROOT = path.resolve(__dirname, '..');
const Paths = require('./paths.js');

function hex(n, w = 2) {
  return '0x' + Number(n).toString(16).toUpperCase().padStart(w, '0');
}
function collKey(usagePage, usage) {
  return hex(usagePage, 2) + ':' + hex(usage == null ? 0 : usage, 2);
}
function parsePid(pid) {
  return hex(pid, 4).slice(2).toLowerCase(); // products/1227/1227.json 目录名用小写 4 位
}

class HidHandle {
  constructor(device, info) {
    this.device = device;   // WebHID 形状的逻辑设备
    this.info = info;       // {path, usagePage, usage, ...} 该 path 的元信息
    this.hid = null;        // node-hid 实例
    this.reading = false;
  }
}

class HidService extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.profiles = JSON.parse(fs.readFileSync(path.join(__dirname, 'hid-profiles.json'), 'utf8'));
    this.productsDir = opts.productsDir || path.join(ROOT, 'webapp', 'products');
    this.authorizedFile = opts.authorizedFile || Paths.stateFile('authorized.json');
    this.cacheFile = opts.cacheFile || Paths.stateFile('collections-cache.json');
    this.log = opts.log || (() => {});
    this.devices = new Map();      // id -> WebHID 形状对象（含 __paths: [HidHandle]）
    this.authorized = new Set(this.#loadAuthorized());
    this.collectionCache = this.#loadCache();
    this.featureLenCache = new Map(); // `${id}:${reportId}` -> length
    this.rawDevices = [];
    // 输入报告轮询间隔：readTimeout(0) 空转只要 ~1ms，5ms 已经足够低延迟（页面侧命令超时普遍 100~500ms）
    this.pollMs = Math.max(1, Number(opts.pollMs || process.env.DAREU_POLL_MS || 5));
  }

  // ── 持久化 ────────────────────────────────────────────────────────────
  #loadAuthorized() {
    try { return JSON.parse(fs.readFileSync(this.authorizedFile, 'utf8')).keys || []; } catch { return []; }
  }
  #saveAuthorized() {
    fs.mkdirSync(path.dirname(this.authorizedFile), { recursive: true });
    fs.writeFileSync(this.authorizedFile, JSON.stringify({ keys: [...this.authorized] }, null, 2));
  }
  #loadCache() {
    try { return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); } catch { return {}; }
  }
  saveCollectionCache(devices) {
    // devices: 从真实 Chrome 抓下来的 [{vendorId,productId,serialNumber,collections}]
    for (const d of devices) {
      this.collectionCache[`${d.vendorId}:${d.productId}:${d.serialNumber || ''}`] = d.collections;
    }
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(this.collectionCache, null, 2));
    this.log(`collections 缓存写入 ${Object.keys(this.collectionCache).length} 条`);
    this.refresh();
  }

  // ── 分组 + collections 合成 ──────────────────────────────────────────
  #groupKey(d) {
    const vid = d.vendorId, pid = d.productId;
    if (d.serialNumber) return `${vid}:${pid}:${d.serialNumber}`;
    // 无序列号：用 Windows path 的硬件实例（去掉 &ColNN / \KBD / GUID 尾巴）
    const p = (d.path || '').toUpperCase();
    const m = p.match(/^\\\\\?\\(HID#[^#]+)/);
    const base = m ? m[1].replace(/&COL\d+/g, '').replace(/\\KBD/g, '') : p;
    return `${vid}:${pid}:${base}`;
  }

  #hwKey(d) {
    // 授权记忆用的“硬件指纹”：不能含每次插拔都会变的实例段
    const p = (d.path || '').toUpperCase();
    const m = p.match(/^\\\\\?\\(HID#[^#]+)/);
    const base = m ? m[1].replace(/&COL\d+/g, '').replace(/\\KBD/g, '') : p;
    return `${d.vendorId}:${d.productId}:${d.serialNumber || base}`;
  }

  #productInfo(pidHex) {
    const f = path.join(this.productsDir, pidHex, pidHex + '.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).Device || null; } catch { return null; }
  }

  #familyFor(group) {
    const pidHex = parsePid(group[0].productId);
    const override = this.profiles.byPid[pidHex.toUpperCase()] || this.profiles.byPid[pidHex];
    if (override && override.family) return { name: override.family, def: this.profiles.families[override.family] };
    const dev = this.#productInfo(pidHex);
    if (dev) {
      for (const [name, def] of Object.entries(this.profiles.families)) {
        if ((def.fwTypes || []).includes(dev.FwType)) return { name, def };
      }
    }
    return null;
  }

  #synthesizeCollections(group, family) {
    const def = family && family.def;               // ← #familyFor 返回 {name, def}，集合表在 def 上
    const out = [];
    const sorted = group.slice().sort((a, b) => (a.interface || 0) - (b.interface || 0) || String(a.path).localeCompare(String(b.path)));
    for (const d of sorted) {
      const key = collKey(d.usagePage, d.usage);
      const spec = def && def.collections ? def.collections[key] : null;
      // Windows Caps 的真实长度（含 Report ID 那 1 字节）；没有就退回家族默认 size（body 长度）
      const bodySize = (spec && spec.size) || (def && def.size) || 64;
      const mk = (ids, len) => (ids || []).map(reportId => ({
        reportId,
        items: [{ type: 'variable', mixed: false, array: false, constant: false, relative: false, reportSize: (len > 1 ? len - 1 : bodySize) }]
      }));
      const c = {
        usagePage: d.usagePage,
        usage: d.usage == null ? 0 : d.usage,
        childLinks: [],
        inputReports: mk(spec && spec.input, spec && spec.inLen),
        outputReports: mk(spec && spec.output, spec && spec.outLen),
        featureReports: mk(spec && spec.feature, spec && spec.featLen),
        // 内部字段（不发给渲染层，但路由/排查要用）
        __path: d.path, __key: key, __role: (spec && spec.role) || 'unknown', __size: bodySize,
        __inLen: (spec && spec.inLen) || 0, __outLen: (spec && spec.outLen) || 0, __featLen: (spec && spec.featLen) || 0
      };
      out.push(c);
      // nestedCount：少数固件把子集合挂在同一个接口描述符里（用 tools/hid-caps.ps1 的 nodes 核对）。
      // 达尔优接收器实测每个 path 的 NumberLinkCollectionNodes = 1，所以默认 1（不合成）。
      for (let n = 1; n < ((spec && spec.nestedCount) || 1); n++) {
        out.push({
          usagePage: 0x01, usage: 0x00, childLinks: [],
          inputReports: [], outputReports: [], featureReports: [],
          __path: d.path, __key: key, __role: 'nested', __size: bodySize,
          __inLen: 0, __outLen: 0, __featLen: 0
        });
      }
    }
    return out;
  }

  #cachedCollections(group) {
    const g = group[0];
    const key = `${g.vendorId}:${g.productId}:${g.serialNumber || ''}`;
    const hit = this.collectionCache[key];
    if (!hit) return null;
    // 缓存来自 Chrome：补齐 __path/__size 等内部字段（按 usagePage:usage 对齐真实 path）
    const byKey = new Map();
    for (const d of group) {
      const k = collKey(d.usagePage, d.usage);
      if (!byKey.has(k)) byKey.set(k, d);
    }
    return hit.map(c => {
      const twin = byKey.get(collKey(c.usagePage, c.usage));
      return {
        usagePage: c.usagePage, usage: c.usage,
        childLinks: c.childLinks || [],
        inputReports: c.inputReports || [], outputReports: c.outputReports || [], featureReports: c.featureReports || [],
        __path: twin ? twin.path : null, __role: 'cached',
        __size: (c.inputReports && c.inputReports[0] && c.inputReports[0].items && c.inputReports[0].items[0] && c.inputReports[0].items[0].reportSize) || 64
      };
    });
  }

  // ── 枚举 ──────────────────────────────────────────────────────────────
  refresh() {
    let raw = [];
    try { raw = HID.devices(); } catch (e) { this.log('枚举失败: ' + e.message); }
    this.rawDevices = raw;

    const groups = new Map();
    for (const d of raw) {
      if (this.profiles.vendorIds.length && !this.profiles.vendorIds.includes(d.vendorId)) {
        // 非达尔优 VID 的设备不参与（授权过的例外会走后面的 vendorId 白名单，这里直接跳过以降噪）
        continue;
      }
      const k = this.#groupKey(d);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }

    const seen = new Set();
    for (const [k, group] of groups) {
      const g0 = group[0];
      const id = k;
      seen.add(id);
      const family = this.#familyFor(group);
      const collections = this.#cachedCollections(group) || this.#synthesizeCollections(group, family);
      const pidHex = parsePid(g0.productId);
      const prod = this.#productInfo(pidHex);

      let dev = this.devices.get(id);
      const isNew = !dev;
      if (isNew) {
        dev = {
          id,
          vendorId: g0.vendorId,
          productId: g0.productId,
          productName: g0.product || '',
          serialNumber: g0.serialNumber || '',
          collections: [],
          opened: false,
          __paths: new Map(),      // path -> HidHandle
          __family: family ? family.name : null,
          __pidHex: pidHex,
          __model: prod ? prod.Model : null,
          __type: prod ? prod.Type : null,
          __fwType: prod ? prod.FwType : null,
          __hwKey: this.#hwKey(g0)
        };
        this.devices.set(id, dev);
      }
      dev.collections = collections;
      dev.productName = g0.product || dev.productName;
      // 维护 path 句柄
      const paths = new Set(group.map(d => d.path));
      for (const [p, h] of dev.__paths) if (!paths.has(p)) { h.close?.(); dev.__paths.delete(p); }
      for (const d of group) {
        if (!dev.__paths.has(d.path)) dev.__paths.set(d.path, new HidHandle(dev, d));
        else dev.__paths.get(d.path).info = d;
      }
      dev.opened = [...dev.__paths.values()].some(h => !!h.hid);
      // __rawCollections 保留 __path/__role/__size 供路由使用；collections 是发给渲染层的公开形状
      dev.__rawCollections = collections;
      dev.collections = collections.map(c => this.#publicCollection(c));
      if (isNew) this.emit('add', dev);
    }
    for (const [id, dev] of this.devices) {
      if (!seen.has(id)) { this.#closeDevice(dev); this.devices.delete(id); this.emit('remove', dev); }
    }
    return this.publicList();
  }

  #publicCollection(c) {
    return {
      usagePage: c.usagePage, usage: c.usage, childLinks: c.childLinks,
      inputReports: c.inputReports, outputReports: c.outputReports, featureReports: c.featureReports
    };
  }

  publicList() {
    return [...this.devices.values()].map(d => this.publicDevice(d));
  }
  publicDevice(d) {
    if (typeof d === 'string') d = this.devices.get(d);
    if (!d) return null;
    const cmd = (d.__rawCollections || []).find(c => c.__role === 'command') || null;
    return {
      id: d.id, vendorId: d.vendorId, productId: d.productId, productName: d.productName,
      serialNumber: d.serialNumber, collections: d.collections, opened: d.opened,
      family: d.__family, model: d.__model, type: d.__type, fwType: d.__fwType,
      authorized: this.authorized.has(d.__hwKey),
      commandKey: cmd ? cmd.__key : '',
      commandPath: cmd ? cmd.__path : '',
      collectionKey: cmd ? cmd.__key : '',
      path: (cmd && cmd.__path) || [...(d.__paths || new Map()).keys()][0] || '',
      interfaces: (d.__rawCollections || []).map(c => ({
        key: c.__key, role: c.__role, path: c.__path,
        inLen: c.__inLen, outLen: c.__outLen, featLen: c.__featLen
      })),
      paths: [...(d.__paths || new Map()).keys()]
    };
  }

  // ── 授权 ──────────────────────────────────────────────────────────────
  authorizedDevices() {
    return [...this.devices.values()].filter(d => this.authorized.has(d.__hwKey)).map(d => this.publicDevice(d));
  }
  authorize(ids) {
    const changed = [];
    for (const id of ids) {
      const dev = this.devices.get(id);
      if (!dev) continue;
      if (!this.authorized.has(dev.__hwKey)) { this.authorized.add(dev.__hwKey); changed.push(dev); }
    }
    if (changed.length) this.#saveAuthorized();
    return changed;
  }
  deauthorize(ids) {
    const changed = [];
    for (const id of ids) {
      const dev = this.devices.get(id);
      const key = dev ? dev.__hwKey : id;
      if (this.authorized.has(key)) { this.authorized.delete(key); changed.push(key); }
    }
    if (changed.length) this.#saveAuthorized();
    return changed;
  }

  // ── 打开 / 关闭 ───────────────────────────────────────────────────────
  /**
   * 只打开 hid-profiles.json 里声明过的接口（__role != 'unknown'）。
   * 理由：复合设备的标准鼠标/键盘接口（usagePage 0x01）由系统独占，CreateFile 能成功但
   * ReadFile 立刻 ACCESS_DENIED(5)，而且真去读它会跟系统抢输入设备。驱动只需要厂商接口。
   */
  #shouldOpen(dev, h) {
    const c = (dev.__rawCollections || []).find(x => x.__path === h.info.path);
    if (!c) return false;
    return c.__role !== 'unknown';
  }
  #openPath(h) {
    if (h.hid) return h;
    h.hid = new HID.HID(h.info.path);
    this.#startRead(h);
    h.device.opened = [...h.device.__paths.values()].some(x => !!x.hid);
    return h;
  }
  open(id) {
    const dev = this.devices.get(id);
    if (!dev) throw new Error('未知设备 ' + id);
    let first = null;
    const wanted = [...dev.__paths.values()].filter(h => this.#shouldOpen(dev, h));
    const list = wanted.length ? wanted : [...dev.__paths.values()];   // 没有 profile 时全开，便于自研新设备
    for (const h of list) {
      try { this.#openPath(h); first = first || h; }
      catch (e) {
        // 某个接口打不开（系统独占/权限）不阻断整体：协议层只会用得到那几个
        this.log(`open ${h.info.path} 失败: ${e.message}`);
      }
    }
    if (!first) throw new Error('设备所有接口都无法打开: ' + id);
    dev.opened = true;
    return this.publicDevice(dev);
  }
  #closeDevice(dev) {
    for (const h of dev.__paths.values()) this.#closeHandle(h);
    dev.opened = false;
  }
  /**
   * node-hid 的 read(cb) 在 Windows 上是「工作线程里阻塞 ReadFile」。在没有数据时直接 hid.close()
   * 会等那个线程，静默设备上有卡死风险；所以先置标志，等回调回来再关（没有回调挂着的就立刻关）。
   * 一次性进程（CLI/自测）不要依赖这里退出——用 process.reallyExit()，句柄由系统回收。
   */
  #closeHandle(h) {
    this.#stopRead(h);
    if (!h.hid) return;
    try { h.hid.close(); } catch { /* ignore */ }
    h.hid = null;
  }
  close(id) {
    const dev = this.devices.get(id);
    if (!dev) return;
    this.#closeDevice(dev);
  }

  /**
   * 读取用「每 20ms 非阻塞轮询 readTimeout(0)」而不是 read(cb)：
   * node-hid 的 read(cb) 在 Windows 上是工作线程里的阻塞 ReadFile，设备静默时 hid.close()
   * 要等那个线程，拔设备和进程退出都可能卡死（实测 process.reallyExit 也走不掉）。
   * 轮询没有挂起的读请求，close 立即返回；20ms 对配置类驱动够用（页面自己的等待循环也是 10ms 量级）。
   */
  #startRead(h) {
    if (h.poll) return;
    h.reading = true;
    const raw = (h.device.__rawCollections || []).find(c => c.__path === h.info.path);
    const role = raw ? raw.__role : '?';
    h.role = role;
    h.rxCount = 0;
    h.poll = setInterval(() => {
      if (!h.hid) { this.#stopRead(h); return; }
      let data;
      try { data = h.hid.readTimeout(0); }
      catch (e) {
        // 系统独占接口/仅 Feature 的接口会立刻报错，同一 path 只报一次，别刷屏
        if (!h.readErrLogged) { h.readErrLogged = true; this.log('停止读取 ' + h.info.path + ': ' + e.message); }
        this.#stopRead(h);
        return;
      }
      if (!data || !data.length) return;
      const buf = Buffer.from(data);
      const reportId = h.device.__noReportIdPrefix ? 0 : buf[0];
      const payload = buf.subarray(1);
      h.rxCount++;
      // 命令/通知通道才记 trace（其它通道可能是持续来的鼠标包，会把 2000 条环形日志冲满）
      if (role === 'command' || role === 'notify') {
        this.log(`[rx] ${role} id=0x${reportId.toString(16).padStart(2, '0')} ${buf.toString('hex').slice(0, 40)}… (${buf.length}B)`);
      }
      this.emit('inputreport', { id: h.device.id, path: h.info.path, usagePage: h.info.usagePage, usage: h.info.usage, reportId, data: payload });
    }, this.pollMs);
    h.poll.unref?.();
  }
  #stopRead(h) {
    if (h.poll) { clearInterval(h.poll); h.poll = null; }
    h.reading = false;
  }

  // ── 报告路由与长度 ────────────────────────────────────────────────────
  #pickHandle(dev, kind, reportId) {
    const raws = dev.__rawCollections || [];
    const handles = [...dev.__paths.values()].filter(h => h.hid);
    const matches = [];
    for (const c of raws) {
      const list = c[kind] || [];
      if (!list.some(r => (r.reportId == null ? 0 : r.reportId) === reportId)) continue;
      if (c.__path) { const h = handles.find(x => x.info.path === c.__path); if (h) matches.push({ h, c }); }
    }
    if (matches.length) return matches[0];
    // 退化：任意声明了该 reportId 的集合 → 用 command/notify 角色的 path
    const declared = raws.some(c => (c[kind] || []).some(r => (r.reportId == null ? 0 : r.reportId) === reportId));
    if (declared) {
      const cmd = raws.find(c => (c.__role === 'command' || c.__role === 'notify') && c.__path);
      const h = cmd && handles.find(x => x.info.path === cmd.__path);
      if (h) return { h, c: cmd };
    }
    // 再退化：优先选「Windows Caps 里确实支持这类报告」的 path（否则 WriteFile 直接 ERROR_INVALID_FUNCTION）
    const wantLen = kind === 'outputReports' ? '__outLen' : kind === 'featureReports' ? '__featLen' : '__inLen';
    const capable = handles.find(h => {
      const c = raws.find(x => x.__path === h.info.path);
      return c && c[wantLen] > 0;
    });
    const any = capable || handles[0];
    if (!any) return null;
    const c = raws.find(x => x.__path === any.info.path) || { __size: 64 };
    return { h: any, c };
  }

  #pad(buf, size) {
    if (size <= 0) return buf;
    if (buf.length === size) return buf;
    const out = Buffer.alloc(size, 0);
    buf.copy(out, 0, 0, Math.min(buf.length, size));
    return out;
  }

  // WebHID: sendReport(reportId, data) —— data 不含 Report ID
  sendReport(id, reportId, data, explicitSize) {
    const dev = this.devices.get(id);
    if (!dev) throw new Error('未知设备 ' + id);
    const pick = this.#pickHandle(dev, 'outputReports', reportId);
    if (!pick) throw new Error(`设备 ${id} 没有 reportId=${reportId} 的输出报告通道`);
    // Windows 要求 WriteFile 长度 == Caps.OutputReportByteLength（含 Report ID），所以 body 长度 = outLen-1
    const size = explicitSize || (pick.c.__outLen > 1 ? pick.c.__outLen - 1 : pick.c.__size || 64);
    const payload = this.#pad(Buffer.from(data), size);
    const wire = Buffer.concat([Buffer.from([reportId & 0xff]), payload]);
    const t0 = Date.now();
    pick.h.hid.write(wire);
    this.log(`[tx] output id=0x${(reportId & 0xff).toString(16).padStart(2, '0')} ${wire.toString('hex').slice(0, 40)}… (${wire.length}B) → ${pick.c.__key} ${Date.now() - t0}ms`);
    return { bytes: wire.length, path: pick.h.info.path, reportId, key: pick.c.__key };
  }

  sendFeatureReport(id, reportId, data, explicitSize) {
    const dev = this.devices.get(id);
    if (!dev) throw new Error('未知设备 ' + id);
    const pick = this.#pickHandle(dev, 'featureReports', reportId);
    if (!pick) throw new Error(`设备 ${id} 没有 reportId=${reportId} 的 Feature 报告通道`);
    const size = explicitSize || (pick.c.__featLen > 1 ? pick.c.__featLen - 1 : pick.c.__size || 64);
    const payload = this.#pad(Buffer.from(data), size);
    const wire = Buffer.concat([Buffer.from([reportId & 0xff]), payload]);
    pick.h.hid.sendFeatureReport(wire);
    return { bytes: wire.length, path: pick.h.info.path, reportId, key: pick.c.__key };
  }

  receiveFeatureReport(id, reportId) {
    const dev = this.devices.get(id);
    if (!dev) throw new Error('未知设备 ' + id);
    const pick = this.#pickHandle(dev, 'featureReports', reportId);
    if (!pick) throw new Error(`设备 ${id} 没有 reportId=${reportId} 的 Feature 报告通道`);
    const cacheKey = `${id}:${reportId}`;
    // Caps.FeatureReportByteLength（含 Report ID）优先；没有就探测（0xFF04:0x02 实测 8 字节，
    // 而 hid-profiles.json 起初按 16 猜，这就是「读得到但内容错位」的来源）
    const declared = pick.c.__featLen > 0 ? pick.c.__featLen : (pick.c.__size || 64) + 1;
    const candidates = [this.featureLenCache.get(cacheKey), declared, ...(this.profiles.featureReportProbeLengths || [])]
      .filter(x => Number.isInteger(x) && x > 0)
      .filter((x, i, a) => a.indexOf(x) === i);
    let lastErr = null;
    for (const len of candidates) {
      try {
        const got = Buffer.from(pick.h.hid.getFeatureReport(reportId, len));
        this.featureLenCache.set(cacheKey, len);
        // hidapi 返回的首字节是 Report ID
        const payload = got.length > 0 && got[0] === reportId ? got.subarray(1) : got;
        return { data: payload, length: len, path: pick.h.info.path };
      } catch (e) { lastErr = e; }
    }
    throw new Error(`getFeatureReport(id=${reportId}) 失败: ${lastErr && lastErr.message}`);
  }

  // 供 CLI / 抓真实 collections 用：扁平列出每个 hidapi path 及其识别键
  allDevices() {
    return [...this.devices.values()].map(d => Object.assign(this.publicDevice(d), {
      pidHex: d.productId.toString(16).padStart(4, '0').toUpperCase(),
      vidHex: d.vendorId.toString(16).padStart(4, '0').toUpperCase()
    }));
  }

  /**
   * 不发硬件、直接造一条 HID 输入报告广播给页面（无真机时验证子页面 oninputreport 解析链）。
   * data 里不含 reportId 字节（WebHID 的 data 从 0 开始，reportId 单独给）。
   */
  injectReport(id, reportId, data) {
    const d = this.devices.get(id);
    if (!d) throw new Error('未知设备: ' + id);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'base64');
    this.emit('inputreport', { id: d.id, reportId: Number(reportId) || 0, data: bytes, injected: true });
    return { ok: true, bytes: bytes.length };
  }

  // 供 CLI/自测使用：让某个集合的 usagePage/usage 直接对应到 path（调试原始报文时用）
  findPathForUsage(id, usagePage, usage) {
    const dev = this.devices.get(id);
    if (!dev) return null;
    const h = [...dev.__paths.values()].find(x => x.info.usagePage === usagePage && x.info.usage === usage);
    return h ? h.info.path : null;
  }

  startPolling(ms = 1500) {
    this.timer = setInterval(() => {
      try { this.refresh(); } catch (e) { this.log('轮询失败: ' + e.message); }
    }, ms);
    this.timer.unref?.();
  }
  stopPolling() { if (this.timer) clearInterval(this.timer); }
  dispose() { this.stopPolling(); for (const d of this.devices.values()) this.#closeDevice(d); }
}

module.exports = { HidService, collKey, parsePid };
