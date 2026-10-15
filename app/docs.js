/* ==========================================================================
 * CAJ 阅读器 — 多文档标签与文件管理
 *
 * 职责：
 *   1. 标签栏 UI（打开 / 切换 / 关闭多个文档）；
 *   2. 每个标签持有自己的 #pages 节点、PDFDocumentProxy 与 ObjectURL，
 *      切换标签 = 换掉 viewer 里的 #pages 节点并恢复 scrollTop ——
 *      不重新解析、不重新转换；
 *   3. 持久化：原始文件放 IndexedDB（库 `cajviewer` / 表 `files`，key = 标签 id），
 *      标签索引放 localStorage['cajviewer.docs']。配额不足或隐私模式下静默降级。
 *
 * 明确不做：
 *   - 不使用 FileSystemFileHandle（iPad Safari 没有这个 API）；
 *   - 本模块不做 CAJ/KDH → PDF 的转换（那是 app.js + wasm 的活），
 *     它只接收「已经是 PDF」的 Blob；
 *   - 本模块不直接操作工具栏、页码、缩略图、目录 —— 那些由 app.js 通过
 *     api.mountInto()/snapshotFromDom() 负责。
 *
 * 本文件顶部没有任何 DOM / 浏览器 API 访问，所以可以在 Node 里直接 import，
 * 用纯函数做自测（IndexedDB 在 Node 下不可用，见文件末尾注释）。
 * ========================================================================== */

/* ─────────────────────────  常量  ───────────────────────── */

/** IndexedDB 库名（AR-2.0.md 规定）。 */
export const DB_NAME = 'cajviewer';
/** IndexedDB 对象仓库名（AR-2.0.md 规定）。 */
export const DB_STORE = 'files';
export const DB_VERSION = 1;

/** localStorage 索引键（AR-2.0.md 规定）。 */
export const INDEX_KEY = 'cajviewer.docs';
export const INDEX_VERSION = 1;

/** 单文件持久化上限：超过就只保留会话内标签（AR-2.0.md 规定 100 MB）。 */
export const MAX_PERSIST_BYTES = 100 * 1024 * 1024;

/** 索引写入的防抖间隔。 */
export const PERSIST_DEBOUNCE_MS = 400;

/** IndexedDB 打开超时：Safari 隐私模式下可能既不 success 也不 error。 */
const DB_OPEN_TIMEOUT_MS = 4000;

/* ─────────────────────────  纯函数（Node 可测）  ───────────────────────── */

let idSeq = 0;

/**
 * 生成标签 id。ids 只用于 DOM data-id / IndexedDB key，所以不需要加密强度，
 * 但要在同一毫秒内也不重复。
 * @param {number} [now]  注入时间戳（自测用）
 * @param {number} [rand] 注入随机数（自测用）
 */
export function makeDocId(now, rand) {
  const t = (Number.isFinite(now) ? now : Date.now()).toString(36);
  const r = Math.floor((Number.isFinite(rand) ? rand : Math.random()) * 0x1000000).toString(36);
  idSeq = (idSeq + 1) % 0x1000000;
  return 'd' + t + '-' + r + '-' + idSeq.toString(36);
}

/** 是否应该把该体积的原始文件写进 IndexedDB。 */
export function shouldPersistBlob(size, limit = MAX_PERSIST_BYTES) {
  return Number.isFinite(size) && size >= 0 && size <= limit;
}

/** 人类可读体积，用于提示文案。 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  const digits = i === 0 || value >= 100 ? 0 : 1;
  return value.toFixed(digits) + ' ' + units[i];
}

/** 把任意输入规整成合法的标签索引项；非法返回 null。 */
export function normalizeTabEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id !== 'string' || !entry.id) return null;
  return {
    id: entry.id,
    fileName: typeof entry.fileName === 'string' && entry.fileName ? entry.fileName : 'document.pdf',
    format: typeof entry.format === 'string' && entry.format ? entry.format.toLowerCase() : 'pdf',
    numPages: Number.isInteger(entry.numPages) && entry.numPages >= 0 ? entry.numPages : 0,
    current: Number.isInteger(entry.current) && entry.current >= 1 ? entry.current : 1,
    scrollTop: Number.isFinite(entry.scrollTop) && entry.scrollTop >= 0 ? entry.scrollTop : 0,
  };
}

/** 序列化索引；只保留 {id,fileName,format,current,scrollTop} 级的轻量数据。 */
export function serializeIndex(tabs, activeId) {
  const list = [];
  const seen = Object.create(null);
  for (const raw of Array.isArray(tabs) ? tabs : []) {
    const entry = normalizeTabEntry(raw);
    if (!entry || seen[entry.id]) continue;
    seen[entry.id] = true;
    list.push(entry);
  }
  const active = typeof activeId === 'string' && seen[activeId] ? activeId : null;
  return JSON.stringify({ v: INDEX_VERSION, active, tabs: list });
}

/**
 * 解析索引；任何坏数据都不许炸启动流程。
 * 返回 { tabs: [...], activeId }，activeId 一定是 tabs 里存在的 id（或 null）。
 */
export function parseIndex(raw) {
  if (typeof raw !== 'string' || !raw) return { tabs: [], activeId: null };
  let obj;
  try { obj = JSON.parse(raw); } catch { return { tabs: [], activeId: null }; }
  if (!obj || typeof obj !== 'object') return { tabs: [], activeId: null };

  const tabs = [];
  const seen = Object.create(null);
  for (const rawEntry of Array.isArray(obj.tabs) ? obj.tabs : []) {
    const entry = normalizeTabEntry(rawEntry);
    if (!entry || seen[entry.id]) continue;
    seen[entry.id] = true;
    tabs.push(entry);
  }

  let activeId = typeof obj.active === 'string' && seen[obj.active] ? obj.active : null;
  if (!activeId && tabs.length) activeId = tabs[tabs.length - 1].id;
  return { tabs, activeId };
}

/**
 * 关闭某个标签后应该切到哪个标签：优先右邻居，没有就左邻居，最后一个都没有返回 null。
 * 不修改入参。
 */
export function pickNeighborId(ids, closingId) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const i = ids.indexOf(closingId);
  if (i < 0) return ids[0];
  if (ids.length <= 1) return null;
  if (i + 1 < ids.length) return ids[i + 1];
  return ids[i - 1];
}

/** 滚动位置只在 [0, max] 内有意义；max 可能未就绪，此时只保证非负。 */
export function clampScrollTop(value, max) {
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  if (Number.isFinite(max) && max >= 0) return Math.min(v, max);
  return v;
}

/* ─────────────────────────  IndexedDB（尽力而为）  ───────────────────────── */

function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function idbGet(key) {
  return withStore('readonly', (store) => store.get(key)).then((rec) => rec || null);
}

function idbPut(key, value) {
  return withStore('readwrite', (store) => store.put(value, key));
}

function idbDelete(key) {
  return withStore('readwrite', (store) => store.delete(key));
}

function withStore(mode, fn) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(DB_STORE, mode); }
      catch (err) { reject(err); return; }

      let result = null;
      try {
        const req = fn(tx.objectStore(DB_STORE));
        if (req) {
          req.onsuccess = () => { result = req.result; };
          req.onerror = () => { /* tx.onerror 会统一收尾 */ };
        }
      } catch (err) { reject(err); return; }

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
    });
  });
}

/**
 * 打开（或复用）数据库连接。任何失败都解析成 reject —— 调用方一律 catch 后降级，
 * 不允许把「存储不可用」升级成「阅读器不可用」。
 *
 * 连接要复用：持久化是 debounce 触发的，每次操作都新开一条连接会攒下一堆
 * 永不关闭的连接，之后真要升级 DB_VERSION 时会被这些旧连接 blocked 到超时。
 */
let dbPromise = null;

function openDb() {
  if (!idbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  let req;
  try { req = indexedDB.open(DB_NAME, DB_VERSION); }
  catch (err) { return Promise.reject(err); }

  dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      dbPromise = null; // 允许下一次调用重试，而不是一直拿同一条失败结果
      reject(err);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      fail(new Error('IndexedDB 打开超时'));
    }, DB_OPEN_TIMEOUT_MS);

    req.onupgradeneeded = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      } catch { /* 建表失败会在 onerror / 事务阶段体现 */ }
    };
    req.onsuccess = () => {
      if (settled) { try { req.result.close(); } catch { /* 忽略 */ } return; }
      settled = true;
      clearTimeout(timer);
      const db = req.result;
      // 其它标签页升级数据库时主动让路，下次操作重新打开
      db.onversionchange = () => {
        try { db.close(); } catch { /* 忽略 */ }
        dbPromise = null;
      };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(req.error || new Error('IndexedDB 打开失败'));
    };
    // blocked 时既不 success 也不 error，交给上面的超时兜底
    req.onblocked = () => {};
  });

  // 调用方 catch 之后不该留着一个已 reject 的缓存
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/* ─────────────────────────  管理器  ───────────────────────── */

/**
 * @param {object}   opts
 * @param {Element}  opts.viewer      #viewer 节点（用于读取/恢复 scrollTop）
 * @param {object}   opts.el          { tabs, tabList, btnNewTab } 或 #docTabs 根节点
 * @param {object}   opts.state       app.js 的 state（只读，用于兜底展示当前页数）
 * @param {object}   opts.api         见 AR-2.0.md 与 task-5 回报里的精确签名
 */
export function createDocManager({ viewer, el, state, api } = {}) {
  const apiLoad = pickFn(api, ['loadPdf', 'load', 'openDocument']);
  const apiSnapshot = pickFn(api, ['snapshotFromDom', 'detach', 'capture']);
  const apiMount = pickFn(api, ['mountInto', 'attach', 'activate']);
  const apiRelease = pickFn(api, ['release', 'destroy']);
  const apiToast = pickFn(api, ['toast']);
  const apiShowEmpty = pickFn(api, ['showEmpty', 'clear']);

  const toast = (msg, kind, ms) => {
    if (apiToast) { try { apiToast(msg, kind, ms); return; } catch { /* 忽略 */ } }
    if (typeof console !== 'undefined') console.warn('[docs]', msg);
  };

  const dom = normalizeEl(el);

  /** @type {Array<object>} 标签记录（顺序即显示顺序） */
  const tabs = [];
  let activeId = null;
  let persistTimer = 0;
  const warned = Object.create(null);

  function warnOnce(key, msg, kind = 'error', ms = 7000) {
    if (warned[key]) return;
    warned[key] = true;
    toast(msg, kind, ms);
  }

  /* ── 标签查找 ── */

  function findTab(id) {
    for (const t of tabs) if (t.id === id) return t;
    return null;
  }

  function readScrollTop() {
    if (viewer && Number.isFinite(viewer.scrollTop)) return Math.max(0, viewer.scrollTop);
    return 0;
  }

  /* ── 索引持久化 ── */

  function writeIndex() {
    try {
      if (typeof localStorage === 'undefined') return;
      // 只写「blob 确实躺在 IndexedDB 里」的标签：给一个恢复不回来的标签留索引，
      // 下次启动只会被 restoreSession 当成坏数据删掉，纯属误导。
      const durable = tabs.filter((t) => t.stored);
      localStorage.setItem(INDEX_KEY, serializeIndex(durable, activeId));
    } catch {
      warnOnce('ls', '无法保存最近文件列表（浏览器存储不可用）', 'error', 6000);
    }
  }

  /** 防抖保存索引（AR 里的 persist()）。 */
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { persistTimer = 0; writeIndex(); }, PERSIST_DEBOUNCE_MS);
  }

  /** 立即保存索引（关闭标签、启动恢复后调用）。 */
  function persistNow() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; }
    writeIndex();
  }

  /* ── IndexedDB 落盘 ── */

  async function hasRoom(size) {
    if (typeof navigator === 'undefined' || !navigator.storage
        || typeof navigator.storage.estimate !== 'function') return true;
    try {
      const info = await navigator.storage.estimate();
      const quota = Number(info && info.quota);
      const usage = Number(info && info.usage);
      if (!Number.isFinite(quota) || quota <= 0) return true;
      // 预留 20% 余量，避免把配额挤爆导致别的写入失败
      return quota - (Number.isFinite(usage) ? usage : 0) > size * 1.2;
    } catch { return true; }
  }

  async function saveBlob(tab) {
    if (!tab.persistable) return false;
    // localStorage 只是「这是个真浏览器」的粗略判据；真正的门槛是 IndexedDB。
    // 少了这一句，隐私模式下 idbPut 会默默解析成 null，却被当成保存成功。
    if (typeof localStorage === 'undefined' || !idbAvailable()) return false;
    const room = await hasRoom(tab.blob.size);
    if (!room) {
      warnOnce('quota-pre', '浏览器存储空间不足，本次不把文件保存到本机（标签仍在）');
      return false;
    }
    try {
      await idbPut(tab.id, {
        blob: tab.blob,
        fileName: tab.fileName,
        format: tab.format,
        addedAt: Date.now(),
      });
      tab.stored = true;
      persistNow(); // 索引里现在才该出现这个标签
      return true;
    } catch {
      warnOnce('idb', '当前浏览器无法保存文件（可能是隐私模式），已切换为临时模式');
      return false;
    }
  }

  async function loadBlobFromIdb(id) {
    try {
      const rec = await idbGet(id);
      return rec && rec.blob ? rec : null;
    } catch { return null; }
  }

  /* ── DOM 渲染 ── */

  function ensureTabEl(tab) {
    if (tab.el && tab.el.isConnected) return tab.el;
    if (!dom.tabList) return null;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'doc-tab';
    btn.dataset.id = tab.id;
    btn.setAttribute('role', 'tab');
    btn.title = tab.fileName;

    const fmt = document.createElement('span');
    fmt.className = 'doc-tab-fmt';
    fmt.setAttribute('aria-hidden', 'true');
    fmt.textContent = String(tab.format || 'pdf').toUpperCase();

    const name = document.createElement('span');
    name.className = 'doc-tab-name';
    name.textContent = tab.fileName;

    const close = document.createElement('span');
    close.className = 'doc-tab-close';
    close.setAttribute('role', 'button');
    close.setAttribute('tabindex', '0');
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';

    btn.append(fmt, name, close);
    tab.el = btn;
    return btn;
  }

  function renderTabs() {
    if (!dom.tabs || !dom.tabList) return;

    // 1) 删掉已经不存在于 tabs 数组里的节点
    const alive = Object.create(null);
    for (const t of tabs) alive[t.id] = true;
    for (const node of Array.from(dom.tabList.children)) {
      if (!alive[node.dataset.id]) node.remove();
    }

    // 2) 新增 / 更新 / 保持顺序
    let prev = null;
    for (const tab of tabs) {
      const node = ensureTabEl(tab);
      if (!node) continue;
      node.dataset.id = tab.id;
      node.title = tab.fileName;

      const nameEl = node.querySelector('.doc-tab-name');
      if (nameEl) nameEl.textContent = tab.fileName;
      const fmtEl = node.querySelector('.doc-tab-fmt');
      if (fmtEl) fmtEl.textContent = String(tab.format || 'pdf').toUpperCase();

      const on = tab.id === activeId;
      node.classList.toggle('is-on', on);
      node.classList.toggle('is-loading', !!tab.loading);
      node.setAttribute('aria-selected', on ? 'true' : 'false');

      if (prev) {
        if (node.previousElementSibling !== prev) prev.after(node);
      } else if (dom.tabList.firstElementChild !== node) {
        dom.tabList.prepend(node);
      }
      prev = node;
    }

    dom.tabs.hidden = tabs.length === 0;

    // 3) 当前标签滚入视野（窄屏横向滚动时很关键）
    if (activeId && dom.tabList.querySelector) {
      const on = dom.tabList.querySelector('.doc-tab[data-id="' + activeId + '"]');
      if (on && typeof on.scrollIntoView === 'function') {
        try { on.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        catch { try { on.scrollIntoView(false); } catch { /* 忽略 */ } }
      }
    }
  }

  function bindDom() {
    if (!dom.tabList || dom.tabList.__docsBound) return;
    dom.tabList.__docsBound = true;

    dom.tabList.addEventListener('click', (ev) => {
      const target = ev.target;
      const closeEl = target && target.closest ? target.closest('.doc-tab-close') : null;
      const tabEl = target && target.closest ? target.closest('.doc-tab') : null;
      if (!tabEl) return;
      const id = tabEl.dataset.id;
      if (closeEl) {
        ev.preventDefault();
        ev.stopPropagation();
        close(id);
        return;
      }
      switchTo(id);
    });

    // 关闭按钮是 span[role=button]，补键盘激活
    dom.tabList.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const target = ev.target;
      if (!target || !target.classList || !target.classList.contains('doc-tab-close')) return;
      const tabEl = target.closest('.doc-tab');
      if (!tabEl) return;
      ev.preventDefault();
      close(tabEl.dataset.id);
    });

    if (dom.btnNewTab) {
      dom.btnNewTab.addEventListener('click', openNewPicker);
    }
  }

  /**
   * 新标签按钮。iOS 上程序化点击 file input 不可靠，而现有 UI 的
   * <label for="fileInput"> 是原生激活路径 —— 优先复用 app.js 的入口。
   */
  function openNewPicker() {
    const picker = pickFn(api, ['openFilePicker', 'pickFile']);
    if (picker) { try { picker(); return; } catch { /* 忽略 */ } }
    if (typeof document === 'undefined') return;
    const label = document.querySelector('label[for="fileInput"]');
    if (label && typeof label.click === 'function') { label.click(); return; }
    const input = document.getElementById('fileInput');
    if (input && typeof input.click === 'function') input.click();
  }

  /* ── 上下文捕获 / 挂载 ── */

  function syncMetaFromCtx(tab, ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    if (Number.isFinite(ctx.scrollTop)) tab.scrollTop = Math.max(0, ctx.scrollTop);
    if (Number.isInteger(ctx.current) && ctx.current >= 1) tab.current = ctx.current;
    if (Number.isInteger(ctx.numPages) && ctx.numPages >= 0) tab.numPages = ctx.numPages;
    if (typeof ctx.fileName === 'string' && ctx.fileName) tab.fileName = ctx.fileName;
    if (typeof ctx.format === 'string' && ctx.format) tab.format = ctx.format.toLowerCase();
  }

  /**
   * 把当前活动文档从 app.js 上摘下来存进标签记录。
   * 必须在「加载下一个文档」之前调用，否则新文档的 loadPdf 会销毁旧文档。
   */
  function captureActive() {
    if (!activeId) return null;
    const tab = findTab(activeId);
    if (!tab) return null;

    let ctx = null;
    if (apiSnapshot) {
      try { ctx = apiSnapshot(); }
      catch (err) { if (typeof console !== 'undefined') console.warn('[docs] snapshotFromDom 失败', err); }
    }
    if (ctx) {
      tab.ctx = ctx;
      syncMetaFromCtx(tab, ctx);
    } else {
      tab.scrollTop = readScrollTop();
      if (state) {
        if (Number.isInteger(state.current) && state.current >= 1) tab.current = state.current;
        if (Number.isInteger(state.numPages) && state.numPages >= 0) tab.numPages = state.numPages;
      }
    }
    return tab;
  }

  function restoreScrollTop(tab) {
    if (!viewer || typeof viewer.scrollTop !== 'number') return;
    const top = clampScrollTop(tab.scrollTop);
    viewer.scrollTop = top;
    // 首帧布局可能还没算完（图片/文本层尚未落地），补一帧再校准一次
    if (top > 0 && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (activeId === tab.id) viewer.scrollTop = clampScrollTop(tab.scrollTop);
      });
    }
  }

  /** 确保标签有 docCtx：没有就从内存 blob / IndexedDB 里取回来重新解析。 */
  async function ensureCtx(tab) {
    if (tab.ctx) return true;
    if (tab.ctxPromise) {
      try { await tab.ctxPromise; } catch { /* 下面按 tab.ctx 判断 */ }
      return !!tab.ctx;
    }
    if (!apiLoad) return false;

    tab.loading = true;
    renderTabs();

    tab.ctxPromise = (async () => {
      let blob = tab.blob;
      if (!blob) {
        const rec = await loadBlobFromIdb(tab.id);
        if (rec) { blob = rec.blob; tab.blob = blob; }
      }
      if (!blob) return;
      tab.ctx = await apiLoad(blob, { fileName: tab.fileName, format: tab.format });
    })();

    try {
      await tab.ctxPromise;
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[docs] loadPdf 失败', err);
      toast('无法打开「' + tab.fileName + '」', 'error', 7000);
    } finally {
      tab.ctxPromise = null;
      tab.loading = false;
      renderTabs();
    }
    return !!tab.ctx;
  }

  /**
   * 同步把「已经解析好」的标签挂到视图上。
   * 关闭激活标签时必须走这条路：邻居的 ctx 早就有了，如果等 activateTab 的
   * 微任务链，close() 返回后会有一帧 activeId 为 null、#pages 也没挂上的空档，
   * 用户会看到空白页，快速连点两次关闭还会卡在无文档状态。
   */
  function mountTabNow(tab) {
    if (!tab || !tab.ctx || !apiMount) return false;
    try {
      apiMount(tab.ctx);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[docs] mountInto 失败', err);
      return false;
    }
    activeId = tab.id;
    syncMetaFromCtx(tab, tab.ctx);
    restoreScrollTop(tab);
    return true;
  }

  async function activateTab(tab) {
    if (!tab) return false;
    if (!(await ensureCtx(tab))) return false;
    if (!apiMount) {
      toast('文档切换暂不可用（集成未完成）', 'error', 7000);
      return false;
    }
    if (!mountTabNow(tab)) return false;
    renderTabs();
    persist();
    return true;
  }

  /* ── 公开动作 ── */

  /** 把应用退回空文档态（没有可显示的标签时）。 */
  function showEmptyState() {
    activeId = null;
    if (apiShowEmpty) { try { apiShowEmpty(); } catch { /* 忽略 */ } }
  }

  /** 摘掉当前活动文档但不销毁它（openFile 开始转换前调用，保证旧文档不被 closeDocument 销毁）。 */
  function detachActive() {
    const tab = captureActive();
    activeId = null;
    renderTabs();
    persist();
    return tab ? tab.id : null;
  }

  function addFromBlob({ blob, fileName, format, pages } = {}) {
    if (!blob) return Promise.reject(new TypeError('addFromBlob 需要一个 Blob'));

    // 先摘旧文档：loadPdf 内部会 closeDocument()，不先摘就会把旧文档销毁
    const previous = captureActive();

    const tab = {
      id: makeDocId(),
      fileName: fileName || (typeof blob.name === 'string' && blob.name) || 'document.pdf',
      format: String(format || 'pdf').toLowerCase(),
      numPages: Number.isInteger(pages) && pages >= 0 ? pages : 0,
      current: 1,
      scrollTop: 0,
      blob,
      ctx: null,
      ctxPromise: null,
      loading: false,
      persistable: shouldPersistBlob(blob.size),
      stored: false, // blob 是否已经确认写进 IndexedDB（决定它进不进恢复索引）
    };
    tabs.push(tab);
    renderTabs();

    if (!tab.persistable) {
      warnOnce('big', '文件有 ' + formatBytes(blob.size) + '，超过 100 MB，只在本次会话保留，不会持久化');
    } else {
      // 落盘是尽力而为：失败只提示一次，不影响本次阅读
      saveBlob(tab).catch(() => {});
    }

    return activateTab(tab).then((ok) => {
      if (!ok) {
        removeTabRecord(tab, { release: true });
        idbDelete(tab.id).catch(() => {});
        renderTabs();
        persistNow();
        // 新文件没打开成功，就把刚才摘下来的旧文档挂回去：
        // 否则用户眼前只剩空白页，旧标签还得手动点回来。
        if (previous && previous.ctx && apiMount) {
          try { apiMount(previous.ctx); activeId = previous.id; } catch { /* 已尽力 */ }
        } else if (!tabs.some((t) => t.id === activeId)) {
          showEmptyState();
        }
        renderTabs();
        return null;
      }
      persistNow();
      return tab.id;
    });
  }

  function list() {
    return tabs.map((t) => ({
      id: t.id,
      fileName: t.fileName,
      format: t.format,
      numPages: t.numPages,
      current: t.current,
      active: t.id === activeId,
    }));
  }

  function switchTo(id) {
    const next = findTab(id);
    if (!next) return Promise.resolve(false);
    if (id === activeId) { renderTabs(); return Promise.resolve(true); }

    const prev = activeId ? findTab(activeId) : null;
    if (prev) captureActive();

    return activateTab(next).then((ok) => {
      if (!ok && prev && prev.ctx && apiMount) {
        // 切不过去就退回原标签，别让用户停在空白页
        try { apiMount(prev.ctx); activeId = prev.id; } catch { /* 已尽力 */ }
        renderTabs();
        return false;
      }
      return ok;
    });
  }

  function removeTabRecord(tab, { release = true } = {}) {
    const idx = tabs.indexOf(tab);
    if (idx >= 0) tabs.splice(idx, 1);
    if (release && tab.ctx && apiRelease) {
      try { apiRelease(tab.ctx); } catch { /* 已尽力 */ }
    }
    tab.ctx = null;
    if (tab.el && tab.el.remove) tab.el.remove();
    if (tab.id === activeId) activeId = null;
  }

  function close(id) {
    const tab = findTab(id);
    if (!tab) return false;

    const wasActive = id === activeId;
    const neighborId = pickNeighborId(tabs.map((t) => t.id), id);

    if (wasActive) captureActive();

    removeTabRecord(tab, { release: true });
    idbDelete(id).catch(() => {});

    if (wasActive) {
      const neighbor = neighborId ? findTab(neighborId) : null;
      if (neighbor) {
        // ctx 已就绪就同步挂上（无空档）；还没解析过才退回异步加载
        if (!mountTabNow(neighbor)) {
          activateTab(neighbor).then((ok) => {
            if (!ok) showEmptyState();
          }, showEmptyState);
        }
      } else {
        showEmptyState();
      }
    }

    renderTabs();
    persistNow();
    return true;
  }

  function closeActive() {
    return activeId ? close(activeId) : false;
  }

  function activeId_() {
    return activeId;
  }

  /** 启动时恢复上次的标签（只恢复 blob 还在的那些）。 */
  async function restoreSession() {
    let parsed;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(INDEX_KEY) : null;
      parsed = parseIndex(raw);
    } catch {
      parsed = { tabs: [], activeId: null };
    }
    if (!parsed.tabs.length) { renderTabs(); return false; }

    const alive = [];
    for (const entry of parsed.tabs) {
      const rec = await loadBlobFromIdb(entry.id);
      if (!rec || !rec.blob) {
        // 取不回原始文件就丢掉这条索引，别给用户留一个点不开的标签
        idbDelete(entry.id).catch(() => {});
        continue;
      }
      alive.push({
        id: entry.id,
        fileName: rec.fileName || entry.fileName,
        format: String(rec.format || entry.format || 'pdf').toLowerCase(),
        numPages: entry.numPages,
        current: entry.current,
        scrollTop: entry.scrollTop,
        blob: rec.blob,
        ctx: null,
        ctxPromise: null,
        loading: false,
        persistable: shouldPersistBlob(rec.blob.size),
        stored: true, // 刚从 IndexedDB 取回来的，当然在库里
      });
    }

    if (!alive.length) {
      try { if (typeof localStorage !== 'undefined') localStorage.removeItem(INDEX_KEY); } catch { /* 忽略 */ }
      renderTabs();
      return false;
    }

    tabs.push(...alive);
    const wanted = parsed.activeId && findTab(parsed.activeId)
      ? parsed.activeId
      : alive[alive.length - 1].id;

    let ok = await activateTab(findTab(wanted));
    if (!ok && alive.length > 1) {
      // 活动标签打不开时退到第一个能打开的
      for (const candidate of alive) {
        if (candidate.id === wanted) continue;
        // eslint-disable-next-line no-await-in-loop
        ok = await activateTab(candidate);
        if (ok) break;
      }
    }
    renderTabs();
    persistNow();
    return !!tabs.length;
  }

  /** 释放全部资源（页面卸载 / 测试收尾用）。 */
  function destroy() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; }
    for (const tab of tabs.slice()) {
      if (tab.ctx && apiRelease) { try { apiRelease(tab.ctx); } catch { /* 忽略 */ } }
      tab.ctx = null;
    }
    tabs.length = 0;
    activeId = null;
    renderTabs();
  }

  bindDom();
  renderTabs();

  return {
    addFromBlob,
    list,
    switchTo,
    close,
    closeActive,
    activeId: activeId_,
    restoreSession,
    persist,
    persistNow,
    detachActive,
    render: renderTabs,
    destroy,
  };
}

/* ─────────────────────────  小工具  ───────────────────────── */

function pickFn(obj, names) {
  if (!obj) return null;
  for (const name of names) {
    if (typeof obj[name] === 'function') return obj[name].bind(obj);
  }
  return null;
}

/** 允许传 { tabs, tabList, btnNewTab } 或直接传 #docTabs 根节点。 */
function normalizeEl(el) {
  if (!el) return { tabs: null, tabList: null, btnNewTab: null };
  if (el.tabs || el.tabList || el.btnNewTab) {
    const tabs = el.tabs || null;
    const root = tabs || el.tabList || null;
    return {
      tabs,
      tabList: el.tabList || (root && root.querySelector ? root.querySelector('.doc-tab-list') : null),
      btnNewTab: el.btnNewTab || (root && root.querySelector ? root.querySelector('.doc-tab-new') : null),
    };
  }
  return {
    tabs: el,
    tabList: el.querySelector ? el.querySelector('.doc-tab-list') : null,
    btnNewTab: el.querySelector ? el.querySelector('.doc-tab-new') : null,
  };
}

/*
 * IndexedDB 在 Node 下不可测（没有 indexedDB / localStorage / DOM），因此自测分两层：
 *   1. 纯函数层：makeDocId / shouldPersistBlob / formatBytes / normalizeTabEntry /
 *      serializeIndex / parseIndex / pickNeighborId / clampScrollTop —— 已导出，可在 Node 断言；
 *   2. 交互层：靠真实浏览器 e2e（lead 维护）与代码走查覆盖。
 */
