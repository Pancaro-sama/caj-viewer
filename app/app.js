/* ==========================================================================
 * CAJ 阅读器 — 应用逻辑
 *
 * 纯前端：CAJ/KDH/HN/C8 → PDF 的转换由 caj2pdf-rust 的 WebAssembly 构建在
 * Web Worker 中完成；PDF 渲染由 Mozilla PDF.js 完成。全程零网络请求。
 * ========================================================================== */

import * as pdfjsLib from '../vendor/pdfjs/build/pdf.min.js';
import { convert, loadModule } from '../vendor/caj2pdf-rust/browser.js';
import { installPinch } from './pinch.js';
import { createDocManager } from './docs.js';
import { installSettings } from './settings.js';
import { VERSION } from './version.js';

// 告诉 index.html 里的启动看门狗：依赖全部加载成功，模块体开始执行。
// 因为 import 会被提升到模块体之前，这一句实际只在所有依赖都就位后才运行 ——
// 所以「有没有这一句」正好区分开「脚本压根没执行」和「执行了但初始化失败」。
// iPad 上没有开发者工具，这个区分决定了用户该去查部署还是查别的地方。
globalThis.__cajLoaded = true;

/* ─────────────────────────  常量  ───────────────────────── */

const VENDOR = new URL('../vendor/', import.meta.url);
const PDFJS = new URL('pdfjs/', VENDOR);

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.min.js', PDFJS).href;

/** pdf.js 的 scale=1 相当于 72dpi；按 96dpi 约定把百分比换算成 scale。 */
const SCALE_PER_PERCENT = 1 / 75;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 8;
/** 同时保留在内存中的已渲染页数上限（iPad 上很关键）。 */
const MAX_LIVE_PAGES = 16;

const $ = (sel) => document.querySelector(sel);

const el = {
  fileName: $('#fileName'),
  formatBadge: $('#formatBadge'),
  pageInput: $('#pageInput'),
  pageCount: $('#pageCount'),
  btnPrev: $('#btnPrev'),
  btnNext: $('#btnNext'),
  btnSidebar: $('#btnSidebar'),
  btnOpen: $('#btnOpen'),
  btnOpenBig: $('#btnOpenBig'),
  btnSelfCheck: $('#btnSelfCheck'),
  btnZoomIn: $('#btnZoomIn'),
  btnZoomOut: $('#btnZoomOut'),
  btnZoomLevel: $('#btnZoomLevel'),
  btnFitWidth: $('#btnFitWidth'),
  btnFitPage: $('#btnFitPage'),
  btnRotate: $('#btnRotate'),
  btnSearch: $('#btnSearch'),
  btnTheme: $('#btnTheme'),
  btnSettings: $('#btnSettings'),
  btnDownload: $('#btnDownload'),
  fileInput: $('#fileInput'),
  sidebar: $('#sidebar'),
  sidebarScrim: $('#sidebarScrim'),
  paneOutline: $('#paneOutline'),
  paneThumbs: $('#paneThumbs'),
  viewerWrap: $('#viewerWrap'),
  viewer: $('#viewer'),
  empty: $('#empty'),
  dropOverlay: $('#dropOverlay'),
  progressOverlay: $('#progressOverlay'),
  progressTitle: $('#progressTitle'),
  progressDetail: $('#progressDetail'),
  progressBar: $('#progressBar'),
  progressPercent: $('#progressPercent'),
  btnCancel: $('#btnCancel'),
  toast: $('#toast'),
  searchBar: $('#searchBar'),
  searchInput: $('#searchInput'),
  searchCount: $('#searchCount'),
  searchPrev: $('#searchPrev'),
  searchNext: $('#searchNext'),
  searchClose: $('#searchClose'),
};

/**
 * 页面容器：单独一层，便于双指缩放时整体做 transform 预览。
 * 多标签：每个文档各有自己的 #pages 节点，切换时通过 activateDocument() 换掉。
 */
let pagesEl = document.createElement('div');
pagesEl.id = 'pages';
el.viewer.append(pagesEl);

/**
 * 运行期装配点。
 *
 * settings.js / docs.js / pinch.js 需要在 app.js 的布局回调里读面板偏好、
 * 在切换文档时刷新面板，但它们都要等到 boot() 才装得上；布局函数在
 * 用户交互之前不会跑，所以这里先放空壳，boot() 里补齐。
 */
const app = {
  prefs: { pageGap: 0, scrollMode: 'continuous' },
  settings: null,
};

/* ─────────────────────────  状态  ───────────────────────── */

function mkDocState() {
  return {
    pdf: null,
    pages: [],
    numPages: 0,
    current: 1,
    fileName: '',
    format: 'pdf',
    fit: 'width',            // 'width' | 'page' | 'custom'
    customScale: 1,
    rotation: 0,
    invert: false,
    theme: 'auto',
    outline: [],
    defaultSize: null,       // 第 1 页在 scale=1 下的 viewport，用作未加载页面的占位尺寸
    firstPage: null,
    objectUrl: null,
    downloadName: 'document.pdf',
    loadToken: 0,
  };
}

/** 当前活动文档的状态。多标签通过切换这个引用实现（app.js 其余代码无需改动）。 */
let state = mkDocState();

const settings = loadSettings();

/* ────────────────────  多文档（标签页）上下文  ──────────────────── */

/**
 * 每个打开的文档 = 一个 docCtx：
 *   { state, pagesEl, scrollTop, ...UI 用字段 }
 * 活动文档的 ctx.state / ctx.pagesEl 就是模块级的 state / pagesEl，
 * 切换文档时把这两个引用换掉即可，渲染、搜索、目录等代码完全不用知道多文档存在。
 */
const docDeps = {
  loadPdf: (blob, opts = {}) => loadPdfIntoNewContext(blob, opts),
  snapshotFromDom: () => deactivateDocument(),
  mountInto: (ctx) => activateDocument(ctx),
  release: (ctx) => releaseDocument(ctx),
  showEmpty: () => closeDocument(),
  toast,
  getState: () => state,
  create: newDocContext,
  deactivate: deactivateDocument,
  releaseActive: releaseActiveDocument,
  switchTo: switchToDocument,
  openFileInto,
  resolveBlob: resolveDocBlob,
  onActivate: null,        // 由 docs.js 注入：同步标签栏高亮
};

/**
 * docs.js 用：把 blob 解析成一个**独立**的 docCtx（不碰当前视图）。
 * blob 必须已经是 PDF —— CAJ/KDH 的转换留在 openFileInto 里做。
 */
async function loadPdfIntoNewContext(blob, { fileName = '', format = 'pdf' } = {}) {
  const ctx = newDocContext();
  ctx.fileName = fileName;
  ctx.format = String(format || 'pdf').toLowerCase();
  ctx.downloadName = suggestPdfName(fileName || 'document.pdf');
  ctx.sourceBlob = blob;
  const token = ++ctx.loadToken;
  await mountPdf(blob, token, ctx);
  if (!ctx.pdf) {
    releaseDocument(ctx);
    throw new Error('PDF 解析失败');
  }
  return ctx;
}

function newDocContext() {
  const ctx = mkDocState();
  ctx.pagesEl = document.createElement('div');
  ctx.pagesEl.id = 'pages';
  ctx.scrollTop = 0;
  ctx.needsShells = false;
  return ctx;
}

/** 当前活动文档的 ctx。 */
let activeDoc = null;

/** 把模块级 state / pagesEl 认领为活动文档（启动时调一次）。 */
function adoptActiveDoc() {
  if (activeDoc) return activeDoc;
  activeDoc = state;
  activeDoc.pagesEl = pagesEl;
  activeDoc.scrollTop = el.viewer ? el.viewer.scrollTop : 0;
  return activeDoc;
}

/** 断开两个 IntersectionObserver（多文档切换时必须断开旧的）。 */
function detachObservers() {
  pageObserver?.disconnect();
  thumbObserver?.disconnect();
}

let pageObserver = null;
let thumbObserver = null;

/** 把活动文档从视图上摘下来（保留 pdf / objectUrl / 已渲染的 canvas）。 */
function deactivateDocument() {
  const ctx = adoptActiveDoc();
  if (el.viewer) ctx.scrollTop = el.viewer.scrollTop;
  ctx.current = state.current;
  ctx.fileName = state.fileName;
  ctx.format = state.format;
  ctx.numPages = state.numPages;
  ctx.downloadName = state.downloadName;
  ctx.sourceBlob = state.sourceBlob || null;
  // 手势进行中切文档会把 transform 留在旧节点上，先取消。
  pinchApi?.cancel?.();
  detachObservers();
  if (ctx.pagesEl.isConnected) {
    ctx.pagesEl.remove();
    ctx.pagesEl.removeAttribute('id');
  }
  return ctx;
}

/** 只把 ctx 接到 DOM 与模块引用上，不做布局（后台标签 + 加载中都用这个）。 */
function attachDocument(ctx) {
  const already = activeDoc === ctx && ctx.pagesEl.isConnected && pagesEl === ctx.pagesEl;
  pagesEl = ctx.pagesEl;
  state = ctx;
  activeDoc = ctx;
  if (!already && !pagesEl.isConnected) {
    // 全文档只允许有一个 id="pages" 参与渲染：后台标签的容器一直挂在
    // ctx 上但不进 DOM，多标签切换时最容易出现重复 id；
    // 这里统一由「挂载」这一步打 id，「摘下」时收回（见 deactivateDocument）。
    // 另外再兜一层底：DOM 里只允许留一个 #pages，任何残留的空容器当场摘掉，
    // 否则 viewport 上会挂着看不见的旧容器（曾经因此留下孤儿容器）。
    for (const stray of el.viewer.querySelectorAll('#pages')) {
      if (stray !== pagesEl) { stray.remove(); stray.removeAttribute('id'); }
    }
    pagesEl.id = 'pages';
    el.viewer.append(pagesEl);
  }
}

/** 把某个 ctx 挂成当前活动文档，并把它的页面真正画出来。 */
function activateDocument(ctx) {
  if (!ctx) return;
  if (ctx === activeDoc) { syncActiveDocUi(); return; }
  if (activeDoc) deactivateDocument();
  attachDocument(ctx);

  const fresh = ctx.numPages > 0 && !ctx.pages.length;
  ensureDocShells();
  attachObservers();
  applyLayout({ preserveAnchor: false });
  el.viewer.scrollTop = fresh ? 0 : (ctx.scrollTop || 0);
  if (fresh) ctx.current = 1;
  syncActiveDocUi();
  renderVisiblePages();
  docDeps.onActivate?.(ctx);
}

/** 把 state 里的元信息刷到工具栏（切标签 / 换文档后都要调）。 */
function syncActiveDocUi() {
  const n = state.numPages || 0;
  state.current = Math.min(Math.max(1, state.current || 1), Math.max(1, n));
  el.pageCount.textContent = n ? `/ ${n}` : '/ 0';
  el.pageInput.value = n ? String(state.current) : '';
  el.empty.hidden = n > 0;
  el.btnDownload.disabled = n === 0;
  el.fileName.textContent = state.fileName || '未打开文件';
  el.fileName.title = state.fileName || '';
  if (n) setFormatBadge(state.format || 'pdf');
  else el.formatBadge.hidden = true;
  updateCurrentFromScroll();
}

/** 真正销毁一个文档上下文（关标签时调用）。 */
function releaseDocument(ctx) {
  if (!ctx) return;
  const wasActive = ctx === activeDoc;
  if (wasActive) activeDoc = null;
  detachObservers();
  try { ctx.pdf?.destroy?.(); } catch { /* 忽略 */ }
  try { if (ctx.objectUrl) URL.revokeObjectURL(ctx.objectUrl); } catch { /* 忽略 */ }
  ctx.pdf = null;
  ctx.objectUrl = null;
  ctx.pages = [];
  ctx.pagesEl.textContent = '';
  ctx.pagesEl.remove();
  if (wasActive) {
    // 别把 state 留在一个已经销毁的 ctx 上
    state = mkDocState();
    pagesEl = document.createElement('div');
    pagesEl.id = 'pages';
  }
}

/** 清掉当前文档（关标签）：先摘下来再销毁。 */
function releaseActiveDocument() {
  const ctx = adoptActiveDoc();
  activeDoc = null;
  releaseDocument(ctx);
  state = mkDocState();
  pagesEl = document.createElement('div');
  pagesEl.id = 'pages';
}

/** 切换标签：把另一个 ctx 挂上来。 */
function switchToDocument(ctx) {
  if (!ctx || ctx === activeDoc) return;
  if (activeDoc) deactivateDocument();
  activateDocument(ctx);
}

/** 文档管理器用：解析成可直接挂载的 PDF blob（CAJ/KDH 走转换器）。 */
async function resolveDocBlob(source, ctx) {
  const token = ++ctx.loadToken;
  if (await isPdfFile(source)) return source;
  showProgress('正在转换…', `${ctx.fileName || ''} · ${formatBytes(source.size)}`);
  setIndeterminate(true);
  try {
    const wasm = await getWasm();
    const chunks = [];
    const sink = {
      async writeChunk(bytes) { chunks.push(bytes); return bytes.byteLength; },
      async flush() {},
    };
    const report = await convert(wasm, source, sink, {
      signal: ctx.abortController?.signal,
      progress: (f) => {
        setIndeterminate(false);
        setProgress(Math.max(0.02, Math.min(0.99, f)));
      },
    });
    return Object.assign(new Blob(chunks, { type: 'application/pdf' }), { __report: report });
  } finally {
    if (ctx.loadToken === token) hideProgress();
  }
}

function loadSettings() {
  const fallback = {
    theme: 'auto', fit: 'width', scale: 1, invert: false, sidebar: true, tab: 'outline',
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem('cajviewer.settings') || '{}') };
  } catch {
    return fallback;
  }
}

function saveSettings() {
  try {
    localStorage.setItem('cajviewer.settings', JSON.stringify({
      theme: state.theme,
      fit: state.fit,
      scale: state.customScale,
      invert: state.invert,
      sidebar: !el.sidebar.hidden,
      tab: el.paneThumbs.hidden ? 'outline' : 'thumbs',
    }));
  } catch { /* 隐私模式忽略 */ }
}

/* ─────────────────────────  Toast 与错误信息  ───────────────────────── */

let toastTimer = null;
function toast(message, kind = '', ms = 4200) {
  el.toast.textContent = message;
  el.toast.className = `toast${kind ? ` is-${kind}` : ''}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

/** 把转换器的稳定错误码翻译成可操作的中文提示。 */
function describeError(err) {
  const code = err?.code || err?.name;
  const map = {
    MALFORMED_CAJ: 'CAJ 文件结构损坏，无法解析',
    MALFORMED_KDH: 'KDH 文件结构损坏，无法解析',
    MALFORMED_PDF: 'PDF 结构损坏，无法解析',
    ENCRYPTED_PDF: '该 PDF 已加密，暂不支持打开',
    UNSUPPORTED_PDF_FEATURE: 'PDF 使用了暂不支持的加密或特性',
    AMBIGUOUS_PDF_REPAIR: 'PDF 损坏方式不唯一，转换器拒绝猜测性修复',
    TRUNCATED_INPUT: '文件不完整，可能在上传或下载中被截断',
    LIMIT_EXCEEDED: '超出转换资源上限',
    PDF_LIMIT_EXCEEDED: '超出 PDF 资源上限',
    CAJ_LIMIT_EXCEEDED: '超出 CAJ 资源上限',
    UNSUPPORTED_FORMAT: err?.format
      ? `已识别为 ${String(err.format).toUpperCase()} 格式，但暂不支持转换`
      : '无法识别的文件格式（不是 CAJ / KDH / HN / C8 / PDF）',
    HNC8: 'HN/C8 内容超出当前实验性支持范围',
    RANDOM_ACCESS_REQUIRED: '此浏览器缺少必要的存储能力，请改用其他浏览器',
    INVALID_INPUT: '输入文件无效',
    CANCELLED: '已取消',
    IO: '读取文件时出错',
    AbortError: '已取消',
  };
  const friendly = map[code] || err?.message || '未知错误';
  const detail = err?.message && err.message !== friendly ? `（${err.message}）` : '';
  return friendly + detail;
}

/* ─────────────────────────  主题  ───────────────────────── */

function applyTheme() {
  const dark = state.theme === 'dark'
    || (state.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  el.btnTheme.title = dark ? '切换到浅色' : '切换到深色';
}

/* ─────────────────────────  工具函数  ───────────────────────── */

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function suggestPdfName(name) {
  const base = String(name || '').replace(/\.[^.\\/]+$/, '') || 'document';
  return `${base}.pdf`;
}

/* ─────────────────────────  打开文件  ───────────────────────── */

/**
 * 加载并缓存转换引擎（WASM 模块）。
 *
 * 正常情况下走 `WebAssembly.compileStreaming`，边下边编译。但不少静态托管会把
 * `.wasm` 发成 application/octet-stream，而 compileStreaming 对 MIME 是严格的 —
 * 这时会直接失败。既然部署到任意托管是设计目标，这里必须能兜住：退化成
 * 一次性 fetch + compile。失败时清掉缓存，下次打开文件再试一次。
 */
let wasmPromise = null;
function getWasm() {
  wasmPromise ||= (async () => {
    try {
      return await loadModule();
    } catch (err) {
      console.warn('WASM 流式编译失败（多半是服务器没把 .wasm 标成 application/wasm），改用一次性编译：', err);
      const response = await fetch(new URL('caj2pdf-rust/caj2pdf_wasm.wasm', VENDOR));
      if (!response.ok) throw new Error(`无法加载转换引擎：HTTP ${response.status}`);
      return WebAssembly.compile(await response.arrayBuffer());
    }
  })().catch((err) => {
    wasmPromise = null;   // 允许下次重试
    throw err;
  });
  return wasmPromise;
}

/** 读文件头，用于「本来就是 PDF」的快速通道。 */
async function isPdfFile(file) {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return head.length >= 5
    && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44
    && head[3] === 0x46 && head[4] === 0x2d; // "%PDF-"
}

/**
 * 打开一个文件。
 *
 * 语义：**新开一个标签**（沿用旧版「打开文件 = 换掉当前文档」的观感 ——
 * 旧文档会留在标签栏里，随时切回来）。转换期间旧文档保持在屏幕上，
 * 转换失败也不会把它弄丢。
 */
async function openFile(file) {
  const name = file.name || 'document.caj';
  try {
    if (await isPdfFile(file)) {
      // 大量 .caj 其实是内嵌 PDF（或干脆就是 PDF）。直接渲染，零拷贝、零等待。
      await openPdfInTab(file, { fileName: name, format: 'pdf' });
      return;
    }

    showProgress('正在转换…', `${name} · ${formatBytes(file.size)}`);
    setIndeterminate(true);

    const wasm = await getWasm();
    const chunks = [];
    let totalBytes = 0;
    const sink = {
      async writeChunk(bytes) {
        chunks.push(bytes);
        totalBytes += bytes.byteLength;
        return bytes.byteLength;
      },
      async flush() {},
    };

    const controller = new AbortController();
    el.btnCancel.onclick = () => controller.abort();

    let report;
    try {
      report = await convert(wasm, file, sink, {
        signal: controller.signal,
        progress: (fraction) => {
          setIndeterminate(false);
          setProgress(Math.max(0.02, Math.min(0.99, fraction)));
          setProgressText(`正在转换… 已读取 ${Math.round(fraction * 100)}%`);
        },
      });
    } finally {
      el.btnCancel.onclick = null;
    }

    setProgress(1);
    setProgressText(`转换完成：${report.pagesConverted} 页 · ${formatBytes(totalBytes)}`);

    const blob = new Blob(chunks, { type: 'application/pdf' });
    hideProgress();

    const id = await openPdfInTab(blob, {
      fileName: name,
      format: report.format || 'pdf',
      report,
    });
    if (!id) toast(`打开失败：无法解析 ${name}`, 'error', 9000);
  } catch (err) {
    hideProgress();
    // 这是「已经告知用户」的可预期失败，用 warn 记录即可，不必污染控制台错误流
    console.warn('打开文件失败：', err);
    if (err?.name === 'AbortError' || err?.code === 'CANCELLED') {
      toast('已取消');
      return;
    }
    toast(`打开失败：${describeError(err)}`, 'error', 9000);
  }
}

/**
 * 把「已经是 PDF」的 blob 交给文档管理器开成新标签。
 * docs.js 的 addFromBlob 内部会先 captureActive()，所以这里不要提前 closeDocument()。
 */
async function openPdfInTab(blob, { fileName = '', format = 'pdf', report = null } = {}) {
  const id = await app.docs.addFromBlob({ blob, fileName, format });
  if (!id) return null;

  if (report?.omittedPages?.length) {
    toast(`有 ${report.omittedPages.length} 页无法恢复，已用空白页替代`, 'error', 8000);
  }
  if (report?.substitutedGlyphs) {
    toast(`有 ${report.substitutedGlyphs} 个字形使用了近似替代`, '', 6000);
  }
  if (report?.outlineOmitted) {
    toast('本文档的目录结构尚未验证，已省略书签', '', 5000);
  }
  return id;
}

/** 在新标签里打开一个文件（标签栏的 ＋ 与拖放多文件用）。 */
async function openFileInNewTab(file) {
  return openFile(file);
}

/** 造一个空白文档并挂到前台，返回它的 ctx。 */
function beginBlankDocument() {
  const previous = activeDoc;
  const ctx = newDocContext();
  ctx.fileName = '';
  if (previous) deactivateDocument();
  attachDocument(ctx);
  el.fileName.textContent = '正在打开…';
  el.fileName.title = '';
  el.formatBadge.hidden = true;
  el.empty.hidden = true;
  el.pageCount.textContent = '/ 0';
  el.pageInput.value = '';
  el.btnDownload.disabled = true;
  el.paneOutline.textContent = '';
  el.paneThumbs.textContent = '';
  docDeps.onActivate?.(ctx);
  return ctx;
}

async function openFileInto(ctx, file) {
  const token = ++ctx.loadToken;
  if (state !== ctx) attachDocument(ctx);
  const name = file.name || 'document.caj';
  el.fileName.textContent = name;
  el.fileName.title = name;
  el.formatBadge.hidden = true;
  ctx.fileName = name;

  const controller = new AbortController();
  ctx.abortController = controller;
  ctx.sourceBlob = file;
  el.btnCancel.onclick = () => controller.abort();
  const stale = () => ctx.loadToken !== token;

  try {
    let blob;
    let format;
    let report = null;

    if (await isPdfFile(file)) {
      // 大量 .caj 其实是内嵌 PDF（或干脆就是 PDF）。直接渲染，零拷贝、零等待。
      blob = file;
      format = 'pdf';
    } else {
      showProgress('正在转换…', `${name} · ${formatBytes(file.size)}`);
      setIndeterminate(true);

      const wasm = await getWasm();
      if (stale()) return;

      const chunks = [];
      let totalBytes = 0;
      const sink = {
        async writeChunk(bytes) {
          chunks.push(bytes);
          totalBytes += bytes.byteLength;
          return bytes.byteLength;
        },
        async flush() {},
      };

      report = await convert(wasm, file, sink, {
        signal: controller.signal,
        progress: (fraction) => {
          setIndeterminate(false);
          setProgress(Math.max(0.02, Math.min(0.99, fraction)));
          setProgressText(`正在转换… 已读取 ${Math.round(fraction * 100)}%`);
        },
      });
      if (stale()) return;

      format = report.format;
      blob = new Blob(chunks, { type: 'application/pdf' });
      setProgress(1);
      setProgressText(`转换完成：${report.pagesConverted} 页 · ${formatBytes(totalBytes)}`);
    }

    if (stale()) return;

    ctx.format = format;
    ctx.fileName = name;
    ctx.downloadName = suggestPdfName(name);

    await mountPdf(blob, token, ctx);
    if (stale()) return;
    state = ctx;

    setFormatBadge(format);
    hideProgress();
    el.empty.hidden = true;
    el.btnDownload.disabled = false;

    if (report?.omittedPages?.length) {
      toast(`有 ${report.omittedPages.length} 页无法恢复，已用空白页替代`, 'error', 8000);
    }
    if (report?.substitutedGlyphs) {
      toast(`有 ${report.substitutedGlyphs} 个字形使用了近似替代`, '', 6000);
    }
    if (report?.outlineOmitted) {
      toast('本文档的目录结构尚未验证，已省略书签', '', 5000);
    }
  } catch (err) {
    hideProgress();
    // 这是「已经告知用户」的可预期失败，用 warn 记录即可，不必污染控制台错误流
    console.warn('打开文件失败：', err);
    if (err?.name === 'AbortError' || err?.code === 'CANCELLED') {
      el.fileName.textContent = '未打开文件';
      toast('已取消');
      return;
    }
    el.fileName.textContent = '未打开文件';
    toast(`打开失败：${describeError(err)}`, 'error', 9000);
  } finally {
    el.btnCancel.onclick = null;
  }
}

function setFormatBadge(format) {
  const fmt = String(format || 'pdf').toLowerCase();
  el.formatBadge.textContent = fmt.toUpperCase();
  el.formatBadge.dataset.fmt = fmt;
  el.formatBadge.hidden = false;
}

/* ─────────────────────────  挂载 PDF  ───────────────────────── */

async function mountPdf(blob, token, ctx = state) {
  // 注意：ctx 可能是个还没激活的后台标签，所以这里一律写 ctx.* 而不是 state.*。
  // 后台标签只做「取 pdf + 记下第 1 页尺寸」，DOM 等 activateDocument() 再补。
  if (ctx.objectUrl) URL.revokeObjectURL(ctx.objectUrl);
  ctx.objectUrl = URL.createObjectURL(blob);

  const pdf = await pdfjsLib.getDocument({
    url: ctx.objectUrl,
    cMapUrl: new URL('cmaps/', PDFJS).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', PDFJS).href,
    wasmUrl: new URL('wasm/', PDFJS).href,
    iccUrl: new URL('iccs/', PDFJS).href,
    stopAtErrors: false, // 转换器产出的 PDF 可能带瑕疵，尽量渲染而不是报错
  }).promise;

  if (ctx.loadToken !== token) { pdf.destroy(); return; }

  ctx.pdf = pdf;
  ctx.numPages = pdf.numPages;
  ctx.current = 1;

  ctx.defaultSize = null;
  ctx.firstPage = null;
  try {
    const first = await pdf.getPage(1);
    ctx.firstPage = first;
    ctx.defaultSize = first.getViewport({ scale: 1, rotation: pageRotation(first) });
  } catch { /* 拿不到就退回逐页布局 */ }
  if (ctx.loadToken !== token) return;

  if (ctx !== state || ctx.needsShells) {
    // 后台标签（或刚被挂上前台、但还没建过 DOM 的标签）：
    // 不建 DOM，等 activateDocument() 里 ensureDocShells() 补上。
    ctx.needsShells = true;
    return;
  }

  el.pageCount.textContent = String(pdf.numPages);
  el.pageInput.value = '1';

  ensureDocShells();

  attachObservers();
  applyLayout({ preserveAnchor: false });
  scrollToPage(1, 'auto');
  renderVisiblePages();
}

/** 当前活动文档还没有页面 DOM 时补上（内部布局 → 目录 → 缩略图）。 */
function ensureDocShells() {
  if (!state.pdf || state.pages.length) { state.needsShells = false; return; }
  el.pageCount.textContent = String(state.numPages);
  if (!el.pageInput.value) el.pageInput.value = '1';
  buildPageShells();
  state.needsShells = false;
  state.outline = [];
  buildOutline();
  buildThumbnails();
  // 目录解析比较慢，放到首屏之后再处理，避免拖慢打开速度。
  const token = state.loadToken;
  loadOutline().then(() => {
    if (token !== state.loadToken) return;
    buildOutline();
    markOutlineActive(state.current);
  }).catch(() => {});
}

function buildPageShells() {
  pagesEl.textContent = '';
  state.pages = [];

  const frag = document.createDocumentFragment();
  for (let num = 1; num <= state.numPages; num++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = String(num);
    frag.append(div);
    state.pages.push({
      num, div, pdfPage: null, pagePromise: null,
      canvas: null, ctx: null, textLayerDiv: null, textLayer: null,
      renderTask: null, viewport: null, scale: 0, rotation: null,
      rendered: false, renderToken: 0,
      textItems: null, textItemsPromise: null,
      thumbEl: null, thumbCanvas: null, thumbDone: false,
    });
  }
  pagesEl.append(frag);
}

/* ─────────────────────────  尺寸 / 布局  ───────────────────────── */

function padPx() {
  return el.viewerWrap.clientWidth < 560 ? 8 : 16;
}

/** 页面自身的 /Rotate 与用户旋转合成，得到真正用于渲染的角度。 */
function pageRotation(pdfPage) {
  return ((((pdfPage?.rotate || 0) + state.rotation) % 360) + 360) % 360;
}

function availSize() {
  const pad = padPx();
  return {
    pad,
    w: Math.max(80, el.viewerWrap.clientWidth - pad * 2),
    h: Math.max(80, el.viewerWrap.clientHeight - pad * 2),
  };
}

/** 由「scale = 1 的 viewport」推导当前缩放模式下应当使用的 scale。 */
function scaleForViewport(vp) {
  if (state.fit === 'custom') return state.customScale;
  const { w, h } = availSize();
  const byWidth = w / vp.width;
  return state.fit === 'page' ? Math.min(byWidth, h / vp.height) : byWidth;
}

function computeScale(pdfPage) {
  return scaleForViewport(pdfPage.getViewport({ scale: 1, rotation: pageRotation(pdfPage) }));
}

/**
 * 还没取到 PDFPageProxy 的页面，先用第 1 页的尺寸占位。
 * 这样滚动条长度从第一帧起就是准的，向下滚动时不会出现「页面忽大忽小」的跳动。
 */
function placeholderBox(p) {
  const d = state.defaultSize;
  if (!d) return null;
  const scale = state.fit === 'custom'
    ? state.customScale
    : (() => {
        const { w, h } = availSize();
        const byWidth = w / d.width;
        return state.fit === 'page' ? Math.min(byWidth, h / d.height) : byWidth;
      })();
  return {
    width: Math.floor(d.width * scale),
    height: Math.floor(d.height * scale),
    scale,
  };
}

/** 设置面板可见时把最新状态同步过去（面板不存在时静默跳过）。 */
function refreshSettingsUi() {
  try { app.settings?.refresh?.(); } catch { /* 面板不该拖垮阅读 */ }
}

/** 走一遍布局；preserveAnchor 保证缩放/旋转后视线不跳。 */
function applyLayout({ preserveAnchor = true } = {}) {
  if (!state.pdf) return;
  const anchor = preserveAnchor ? captureAnchor() : null;
  const pad = padPx();
  const gap = Math.max(0, Number(app.prefs.pageGap) || 0);

  el.viewer.classList.toggle('single-page', app.prefs.scrollMode === 'single');

  for (const p of state.pages) {
    p.div.style.marginTop = p.num === 1 ? `${pad}px` : `${gap}px`;
    p.div.style.marginBottom = p.num === state.pages.length ? `${pad}px` : `${gap}px`;

    if (p.pdfPage) {
      applyPageBox(p, computeScale(p.pdfPage));
    } else {
      const box = placeholderBox(p);
      if (box) {
        p.div.style.width = `${box.width}px`;
        p.div.style.height = `${box.height}px`;
        p.div.style.setProperty('--scale-factor', String(box.scale));
      }
    }
  }

  if (anchor) restoreAnchor(anchor);

  el.btnZoomLevel.textContent = `${currentPercent()}%`;
  el.btnFitWidth.classList.toggle('is-on', state.fit === 'width');
  el.btnFitPage.classList.toggle('is-on', state.fit === 'page');
  updateCurrentFromScroll();
  refreshSettingsUi();
}

function currentPercent() {
  const p = state.pages[state.current - 1];
  return Math.round((p?.scale || state.customScale) / SCALE_PER_PERCENT);
}

function applyPageBox(p, scale) {
  const viewport = p.pdfPage.getViewport({ scale, rotation: pageRotation(p.pdfPage) });
  const changed = p.scale !== scale || p.rotation !== state.rotation;

  p.scale = scale;
  p.rotation = state.rotation;
  p.viewport = viewport;

  p.div.style.width = `${Math.floor(viewport.width)}px`;
  p.div.style.height = `${Math.floor(viewport.height)}px`;
  p.div.style.setProperty('--scale-factor', String(scale));
  p.div.style.setProperty('--user-unit', String(viewport.userUnit || 1));

  if (changed) {
    p.rendered = false;
    // 只有确实有东西要回收时才走 releasePage（它会让在途渲染的令牌失效）
    if (p.canvas || p.textLayerDiv || p.renderTask) releasePage(p);
  } else if (p.canvas) {
    p.canvas.style.width = `${Math.floor(viewport.width)}px`;
    p.canvas.style.height = `${Math.floor(viewport.height)}px`;
  }
}

/* ── 滚动锚点 ───────────────────────────────────────────── */

/** 记录视口中某一点对应的「页 + 页内比例」。 */
function captureAnchorAtClientY(clientY) {
  const rect = el.viewer.getBoundingClientRect();
  const offsetPx = Math.max(0, Math.min(el.viewer.clientHeight - 1, clientY - rect.top));
  const y = el.viewer.scrollTop + offsetPx;
  for (const p of state.pages) {
    const off = p.div.offsetTop;
    const h = p.div.offsetHeight || 1;
    if (off + h > y) return { num: p.num, frac: Math.max(0, (y - off) / h), offsetPx };
  }
  return { num: state.current, frac: 0, offsetPx };
}

function captureAnchor() {
  return captureAnchorAtClientY(el.viewer.getBoundingClientRect().top);
}

function restoreAnchor(anchor) {
  const p = state.pages[anchor.num - 1];
  if (!p) return;
  const target = p.div.offsetTop + anchor.frac * (p.div.offsetHeight || 1) - (anchor.offsetPx || 0);
  el.viewer.scrollTop = Math.max(0, target);
}

/* ─────────────────────────  页面渲染  ───────────────────────── */

function ensurePdfPage(p) {
  if (p.pdfPage) return Promise.resolve(p.pdfPage);
  if (!p.pagePromise) {
    p.pagePromise = state.pdf.getPage(p.num).then((pg) => { p.pdfPage = pg; return pg; });
  }
  return p.pagePromise;
}

async function renderPage(p) {
  if (p.rendered && p.canvas) return;
  if (p.renderTask) return;

  const waitToken = ++p.renderToken;

  try { await ensurePdfPage(p); } catch { return; }
  if (waitToken !== p.renderToken || !p.pdfPage) return;

  // 首次拿到真实页面尺寸。注意 applyPageBox 可能触发 releasePage 而使令牌失效，
  // 所以必须在它之后再取一次令牌，否则渲染完会被自己误判为「已过期」而丢弃文本层。
  if (!p.viewport) applyPageBox(p, computeScale(p.pdfPage));
  if (!p.pdfPage || !p.viewport) return;

  const myToken = ++p.renderToken;
  const viewport = p.viewport;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(1, Math.floor(viewport.width));
  const cssH = Math.max(1, Math.floor(viewport.height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const spinner = document.createElement('div');
  spinner.className = 'page-spinner';

  p.div.textContent = '';
  p.div.append(canvas, spinner);

  p.canvas = canvas;
  p.ctx = canvas.getContext('2d', { alpha: false });

  const task = p.pdfPage.render({
    canvasContext: p.ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  p.renderTask = task;

  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('页面渲染失败', p.num, err);
    return;
  } finally {
    if (p.renderTask === task) p.renderTask = null;
  }

  if (myToken !== p.renderToken) return;
  spinner.remove();
  p.rendered = true;
  renderTextLayer(p, myToken).catch(() => {});
}

/** 文本层：支持选中、复制与查找高亮。 */
async function renderTextLayer(p, myToken) {
  try {
    if (!p.textLayerDiv) {
      p.textLayerDiv = document.createElement('div');
      p.textLayerDiv.className = 'textLayer';
      p.div.append(p.textLayerDiv);
    }
    p.textLayer?.cancel?.();
    p.textLayerDiv.textContent = '';

    const layer = new pdfjsLib.TextLayer({
      textContentSource: p.pdfPage.streamTextContent({ includeMarkedContent: true }),
      container: p.textLayerDiv,
      viewport: p.viewport,
    });
    p.textLayer = layer;
    await layer.render();
    if (myToken !== p.renderToken) return;
    if (searchState.query) applyHighlights(p);
  } catch (err) {
    if (err?.name !== 'AbortException') console.warn('文本层失败', p.num, err);
  }
}

function releasePage(p) {
  p.renderTask?.cancel?.();
  p.renderTask = null;
  p.textLayer?.cancel?.();
  p.textLayer = null;
  p.renderToken++;
  try { p.pdfPage?.cleanup?.(); } catch { /* 忽略 */ }
  p.div.textContent = '';
  p.canvas = null;
  p.ctx = null;
  p.textLayerDiv = null;
  p.rendered = false;
}

/** 视野附近应当保持「已渲染」的纵向范围（比视口向外扩一圈）。 */
function renderBand() {
  const pad = Math.max(1200, el.viewer.clientHeight);
  return {
    top: el.viewer.scrollTop - pad,
    bottom: el.viewer.scrollTop + el.viewer.clientHeight + pad,
  };
}

function pagesInBand() {
  const band = renderBand();
  const out = [];
  for (const p of state.pages) {
    const off = p.div.offsetTop;
    if (off + p.div.offsetHeight >= band.top && off <= band.bottom) out.push(p);
  }
  return out;
}

/**
 * 释放离当前位置太远的页面，避免 iPad 上内存耗尽。
 *
 * 绝不回收仍处在渲染带内的页面：IntersectionObserver 只在「进入/离开」的那一刻
 * 回调一次，如果在这里把一页清空、而它并没有离开观察范围，观察器之后不会再通知，
 * 这一页就会永久空白。这正是「向后翻全是空白页」的成因。
 */
function prunePages() {
  const live = state.pages.filter((p) => p.rendered);
  if (live.length <= MAX_LIVE_PAGES) return;

  const inBand = new Set(pagesInBand());
  live.sort((a, b) => Math.abs(b.num - state.current) - Math.abs(a.num - state.current));

  let remaining = live.length;
  for (const p of live) {
    if (remaining <= MAX_LIVE_PAGES) break;
    if (inBand.has(p)) continue;
    releasePage(p);
    remaining--;
  }
}

/* ─────────────────────────  可见性观察  ───────────────────────── */

function attachObservers() {
  pageObserver?.disconnect();
  pageObserver = new IntersectionObserver((entries) => {
    const anchor = captureAnchor();
    let moved = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const p = state.pages[Number(entry.target.dataset.page) - 1];
      if (!p) continue;
      if (!p.pdfPage) moved = true;
      renderPage(p);
    }
    if (moved) {
      // 真实页面尺寸可能和占位不同；等它落到 DOM 之后再校正滚动位置。
      setTimeout(() => { restoreAnchor(anchor); updateCurrentFromScroll(); }, 60);
    }
    prunePages();
  }, { root: el.viewer, rootMargin: '1200px 0px', threshold: 0 });

  for (const p of state.pages) pageObserver.observe(p.div);
}

/**
 * 把「视野附近但还没画出来」的页面补上。
 *
 * IntersectionObserver 只在页面进入/离开观察范围的那一刻回调一次。一旦某页在可见
 * 范围内被回收、或那一次渲染被打断，它就再也不会收到通知 —— 表现为滚动时出现
 * 一片永远不消失的空白页。所以每次滚动都主动对账一次，让渲染变成自愈的。
 */
function renderVisiblePages() {
  const todo = [];
  for (const p of pagesInBand()) {
    if (!p.rendered && !p.renderTask) todo.push(p);
  }
  // 先读完布局再动手渲染，避免边读 offsetTop 边写 DOM 造成反复重排
  for (const p of todo) renderPage(p);
}

/* ─────────────────────────  滚动 / 当前页  ───────────────────────── */

let scrollRaf = 0;
el.viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    updateCurrentFromScroll();
    renderVisiblePages();   // 兜底：观察器没通知到的页面，这里补上
  });
}, { passive: true });

function updateCurrentFromScroll() {
  if (state.pages.length) {
    const mid = el.viewer.scrollTop + el.viewer.clientHeight * 0.35;

    let best = state.pages[0];
    for (const p of state.pages) {
      if (p.div.offsetTop <= mid) best = p;
      else break;
    }
    if (best.num !== state.current) {
      state.current = best.num;
      el.pageInput.value = String(best.num);
      markOutlineActive(best.num);
      markThumbActive(best.num);
      prunePages();
    }
  }
  syncCurrentPageMarker();
}

/** 单页模式靠 .is-current 决定哪一页可见；切文档时也要重标一次。 */
function syncCurrentPageMarker() {
  for (const p of state.pages) {
    p.div.classList.toggle('is-current', p.num === state.current);
  }
}

function scrollToPage(num, behavior = 'auto') {
  const p = state.pages[Math.max(0, Math.min(state.numPages - 1, num - 1))];
  if (!p) return;
  state.current = p.num;
  el.pageInput.value = String(p.num);
  el.viewer.scrollTo({ top: p.div.offsetTop, behavior });
  markOutlineActive(p.num);
  markThumbActive(p.num);
  syncCurrentPageMarker();
}

/* ─────────────────────────  缩放  ───────────────────────── */

function setFit(mode) {
  state.fit = mode;
  if (mode === 'custom') state.customScale = state.pages[state.current - 1]?.scale || 1;
  applyLayout();
  renderVisiblePages();
  saveSettings();
}

function zoomTo(scale, { fit = 'custom' } = {}) {
  state.fit = fit;
  state.customScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
  applyLayout();
  renderVisiblePages();
  saveSettings();
}

function zoomBy(factor) {
  const base = state.pages[state.current - 1]?.scale || state.customScale;
  zoomTo(base * factor);
}

el.btnZoomIn.addEventListener('click', () => zoomBy(1.25));
el.btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.25));
el.btnZoomLevel.addEventListener('click', () => zoomTo(1 / SCALE_PER_PERCENT));
el.btnFitWidth.addEventListener('click', () => setFit('width'));
el.btnFitPage.addEventListener('click', () => setFit('page'));

/** 顺时针旋转 90°（工具栏按钮与设置面板共用）。 */
function rotate() {
  state.rotation = (state.rotation + 90) % 360;
  if (state.firstPage) {
    state.defaultSize = state.firstPage.getViewport({ scale: 1, rotation: pageRotation(state.firstPage) });
  }
  for (const p of state.pages) { p.viewport = null; p.scale = 0; releasePage(p); }
  applyLayout({ preserveAnchor: true });
  renderVisiblePages();
  invalidateThumbnails();
  refreshSettingsUi();
}

el.btnRotate.addEventListener('click', rotate);

/**
 * 旋转后缩略图必须重画：renderThumb 用 p.thumbDone 做「已画过」的标记，
 * 而旋转并不会让这个标记失效 —— 结果侧栏里的缩略图会一直停在旧方向，
 * 和正文对不上。这里统一把标记清掉，并让在视野内的缩略图立刻重画。
 */
function invalidateThumbnails() {
  for (const p of state.pages) {
    p.thumbDone = false;
    if (p.thumbCanvas) {
      p.thumbCanvas.width = 0;
      p.thumbCanvas.height = 0;
    }
  }
  if (el.paneThumbs.hidden) return;
  for (const p of state.pages) {
    const el2 = p.thumbEl;
    if (!el2 || el2.offsetParent === null) continue;
    renderThumb(p);
  }
}

/* 桌面：Ctrl/⌘ + 滚轮缩放 */
el.viewer.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !state.pdf) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

/* 双指缩放：几何与手势状态机都在 app/pinch.js（唯一入口 installPinch）。
   这里只负责把 app.js 里的布局/缩放/锚点能力喂给它，并做两处适配：
     · pagesEl 用 getter 转发 —— 多标签下页面容器会被换掉；
     · 手势进行中切换文档要取消手势（否则变换会留在旧节点上）。 */
const pagesElProxy = {
  get style() { return pagesEl.style; },
  get children() { return pagesEl.children; },
  get classList() { return pagesEl.classList; },
  getBoundingClientRect: () => pagesEl.getBoundingClientRect(),
};

const pinchApi = installPinch({
  viewer: el.viewer,
  pagesEl: pagesElProxy,
  captureAnchorAtClientY,
  restoreAnchor,
  applyLayout,
  zoomTo,
  setFit,
  getStartScale: () => state.pages[state.current - 1]?.scale || state.customScale,
  getZoomLabel: () => el.btnZoomLevel,
  SCALE_PER_PERCENT, ZOOM_MIN, ZOOM_MAX,
  isReady: () => !!state.pdf && state.numPages > 0,
});

/* 触屏双击：在「适应宽度」与 220% 之间切换 */
let lastTapAt = 0;
el.viewer.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' || !state.pdf) return;
  // 双指抬起时第二根手指的 pointerup 可能晚于 touchend，
  // 只用 isActive() 会把它误判成双击。
  if (pinchApi.isActive() || pinchApi.recentlyActive(400)) return;
  if (e.target.closest('.textLayer')) return; // 不干扰选词
  const now = performance.now();
  if (now - lastTapAt > 320) { lastTapAt = now; return; }
  lastTapAt = 0;
  const anchor = captureAnchorAtClientY(e.clientY);
  if (state.fit === 'custom') setFit('width');
  else zoomTo(220 * SCALE_PER_PERCENT);
  restoreAnchor(anchor);
}, { passive: true });

/* ─────────────────────────  多文档 / 设置面板  ───────────────────────── */

/** 设置面板要用的字段（值类型，面板只读）。 */
function sidebarDefaultPref() {
  try {
    const raw = JSON.parse(localStorage.getItem('cajviewer.settings') || '{}');
    return typeof raw.sidebar === 'boolean' ? raw.sidebar : true;
  } catch {
    return true;
  }
}

/** 清掉恢复索引（IndexedDB 里缓存的文件与 localStorage 索引），打开的标签不受影响。 */
async function clearRecentFiles() {
  let cleared = false;
  try {
    if (typeof indexedDB !== 'undefined') {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('cajviewer');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
      cleared = true;
    }
  } catch { /* 隐私模式 / 无 IndexedDB 时静默降级 */ }
  try {
    localStorage.removeItem('cajviewer.docs');
    cleared = true;
  } catch { /* 忽略 */ }
  return cleared;
}

/** 设置面板（app/settings.js）看到的「应用门面」。 */
const appFacade = {
  state: () => state,
  version: VERSION,
  docs: null,        // 构造完 docs 之后补上
  SCALE_PER_PERCENT,
  updateUrl: '',     // 有发布页（GitHub Pages / 静态托管）时填这里
  /**
   * 取站点根目录的版本清单。发布产物由 tools/make-version-json.mjs 生成；
   * 本地开发环境没有它也很正常，返回 null 即可（设置面板会显示为「未配置发布源」）。
   */
  async fetchPublishedVersion() {
    const res = await fetch(new URL('../version.json', import.meta.url), { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.app === 'string' ? data : null;
  },
  toast,
  runSelfCheck,
  warmOfflineCache,
  scrollToPage,
  setFit,
  zoomTo,
  rotate,
  invalidateThumbnails,
  openFile,
  closeDocument,
  saveSettings,
  applyTheme,
  setTheme(mode) {
    state.theme = (mode === 'light' || mode === 'dark') ? mode : 'auto';
    applyTheme();
    saveSettings();
    refreshSettingsUi();
  },
  setInvert(on) {
    state.invert = !!on;
    el.viewer.classList.toggle('invert-pages', state.invert);
    saveSettings();
  },
  getSidebarDefault: sidebarDefaultPref,
  setSidebarDefault(on) {
    settings.sidebar = !!on;
    saveSettings();
  },
  setPageGap(px) {
    app.prefs.pageGap = Math.max(0, Number(px) || 0);
    applyLayout();
  },
  setScrollMode(mode) {
    app.prefs.scrollMode = mode === 'single' ? 'single' : 'continuous';
    applyLayout({ preserveAnchor: false });
    renderVisiblePages();
  },
  clearRecentFiles,
};

/**
 * 文档管理器：标签栏、切换、关闭、IndexedDB 持久化都在 docs.js 里。
 * 这里只把 app.js 的文档能力喂给它。
 */
app.docs = createDocManager({
  viewer: el.viewer,
  el: { tabs: $('#docTabs'), tabList: $('#docTabList'), btnNewTab: $('#btnNewTab') },
  state,
  api: {
    ...docDeps,
    addPdfBlob: (blob, fileName, format) => openPdfInTab(blob, { fileName, format }),
    openFilePicker: pickFile,
  },
});
appFacade.docs = app.docs;

// 标签切换成功后同步设置面板里的「当前文档」列表
app.docs.onActivate = () => {
  refreshSettingsUi();
};

/**
 * 设置面板的安装必须留到 boot() 之后再做：
 * appFacade 里的字段是 module 级 const / function，模块求值阶段还会撞上
 * 暂时性死区；boot() 跑的时候整个模块已经求值完毕。
 */
function ensureSettingsPanel() {
  if (app.settings) return app.settings;
  app.settings = installSettings({ app: appFacade, overlayEl: $('#settingsOverlay') });
  app.prefs = app.settings.getPrefs();
  // 阅读偏好由设置面板持久化在另一个 key 里；不在这里回灌，重启后
  // 页面间距与单页模式就只是显示对了、布局没跟上（用户会以为设置丢了）。
  applyReadingPrefs();
  return app.settings;
}

/** 把 app.prefs 落到布局上（文档还没打开时 applyLayout 会自行跳过）。 */
function applyReadingPrefs() {
  el.viewer.classList.toggle('single-page', app.prefs.scrollMode === 'single');
  if (state.pdf) applyLayout();
}

/* ─────────────────────────  符号预览（仅双击用）  ───────────────────────── */

/* ─────────────────────────  页码导航  ───────────────────────── */

el.btnPrev.addEventListener('click', () => scrollToPage(state.current - 1));
el.btnNext.addEventListener('click', () => scrollToPage(state.current + 1));

el.pageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = parseInt(el.pageInput.value, 10);
  if (Number.isFinite(n)) scrollToPage(Math.max(1, Math.min(state.numPages, n)));
  el.pageInput.blur();
});
el.pageInput.addEventListener('blur', () => { el.pageInput.value = String(state.current); });
el.pageInput.addEventListener('focus', () => el.pageInput.select());

/* ─────────────────────────  侧栏：目录  ───────────────────────── */

function buildOutline() {
  el.paneOutline.textContent = '';
  if (!state.outline.length) {
    const p = document.createElement('p');
    p.className = 'pane-empty';
    p.textContent = '本文档没有目录';
    el.paneOutline.append(p);
    return;
  }
  el.paneOutline.append(buildOutlineList(state.outline));
}

function buildOutlineList(items) {
  const ul = document.createElement('ul');
  ul.className = 'olist';
  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'olink';
    btn.dataset.page = item.page ? String(item.page) : '';

    const title = document.createElement('span');
    title.className = 'otitle';
    title.textContent = item.title || '(无标题)';
    btn.append(title);

    if (item.page) {
      const pn = document.createElement('span');
      pn.className = 'opage';
      pn.textContent = String(item.page);
      btn.append(pn);
    }
    btn.addEventListener('click', () => {
      if (item.page) scrollToPage(item.page, 'smooth');
      if (el.viewerWrap.clientWidth < 900) toggleSidebar(false);
    });
    li.append(btn);
    if (item.items?.length) li.append(buildOutlineList(item.items));
    ul.append(li);
  }
  return ul;
}

function markOutlineActive(pageNum) {
  const links = [...el.paneOutline.querySelectorAll('.olink')];
  for (const a of links) a.classList.remove('is-on');
  let best = null;
  for (const a of links) {
    const n = Number(a.dataset.page);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n <= pageNum) best = a;
  }
  best?.classList.add('is-on');
  best?.scrollIntoView({ block: 'nearest' });
}

/** 把 pdf.js 的目录树解析成带页码的结构。 */
async function loadOutline() {
  let raw = [];
  try { raw = (await state.pdf.getOutline()) || []; } catch { raw = []; }
  if (!raw.length) return;

  const walk = async (items) => {
    const out = [];
    for (const it of items) {
      let page = null;
      try {
        const dest = typeof it.dest === 'string' ? await state.pdf.getDestination(it.dest) : it.dest;
        if (Array.isArray(dest) && dest[0] != null) {
          page = (await state.pdf.getPageIndex(dest[0])) + 1;
        }
      } catch { /* 目标无效则保留无页码 */ }
      out.push({
        title: it.title,
        page,
        items: it.items?.length ? await walk(it.items) : null,
      });
    }
    return out;
  };

  state.outline = await walk(raw);
}

/* ─────────────────────────  侧栏：缩略图  ───────────────────────── */

function buildThumbnails() {
  el.paneThumbs.textContent = '';
  const frag = document.createDocumentFragment();
  for (const p of state.pages) {
    const btn = document.createElement('button');
    btn.className = 'thumb';
    btn.dataset.page = String(p.num);

    const canvas = document.createElement('canvas');
    canvas.className = 'thumb-canvas';
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = String(p.num);
    btn.append(canvas, num);

    btn.addEventListener('click', () => {
      scrollToPage(p.num, 'smooth');
      if (el.viewerWrap.clientWidth < 900) toggleSidebar(false);
    });

    frag.append(btn);
    p.thumbEl = btn;
    p.thumbCanvas = canvas;
    p.thumbDone = false;
  }
  el.paneThumbs.append(frag);
}

function observeThumbs() {
  thumbObserver?.disconnect();
  if (el.paneThumbs.hidden) return;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const p = state.pages[Number(entry.target.dataset.page) - 1];
      if (p) renderThumb(p);
    }
  }, { root: el.paneThumbs, rootMargin: '400px 0px' });
  for (const p of state.pages) if (p.thumbEl) thumbObserver.observe(p.thumbEl);
}

async function renderThumb(p) {
  if (p.thumbDone) return;
  p.thumbDone = true;
  try {
    await ensurePdfPage(p);
    const base = p.pdfPage.getViewport({ scale: 1 });
    const vp = p.pdfPage.getViewport({ scale: 150 / base.width, rotation: state.rotation });
    p.thumbCanvas.width = Math.floor(vp.width);
    p.thumbCanvas.height = Math.floor(vp.height);
    p.thumbEl.style.aspectRatio = `${Math.round(vp.width)} / ${Math.round(vp.height)}`;
    const ctx = p.thumbCanvas.getContext('2d', { alpha: false });
    await p.pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
  } catch {
    p.thumbDone = false;
  }
}

function markThumbActive(pageNum) {
  for (const t of el.paneThumbs.querySelectorAll('.thumb')) {
    t.classList.toggle('is-on', Number(t.dataset.page) === pageNum);
  }
}

/* ─────────────────────────  侧栏开关  ───────────────────────── */

/** 窄屏时侧栏必须是浮层抽屉，否则它会把正文挤成一条。 */
function syncSidebarMode() {
  const overlay = el.viewerWrap.clientWidth < 900;
  const open = !el.sidebar.hidden;
  el.sidebar.classList.toggle('is-overlay', open && overlay);
  el.sidebarScrim.hidden = !(open && overlay);
}

function toggleSidebar(force) {
  const show = force ?? el.sidebar.hidden;
  el.sidebar.hidden = !show;
  syncSidebarMode();
  saveSettings();
}

el.btnSidebar.addEventListener('click', () => toggleSidebar());
el.sidebarScrim.addEventListener('click', () => toggleSidebar(false));

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-on', t === tab);
    const thumbs = tab.dataset.tab === 'thumbs';
    el.paneThumbs.hidden = !thumbs;
    el.paneOutline.hidden = thumbs;
    if (thumbs) observeThumbs();
    saveSettings();
  });
}

/* ─────────────────────────  查找  ───────────────────────── */

const searchState = { query: '', hits: [], index: -1, runToken: 0 };

function openSearch() {
  el.searchBar.hidden = false;
  el.searchInput.focus();
  el.searchInput.select();
}

function closeSearch() {
  el.searchBar.hidden = true;
  searchState.query = '';
  searchState.hits = [];
  searchState.index = -1;
  el.searchCount.textContent = '';
  for (const p of state.pages) clearHighlights(p);
}

el.btnSearch.addEventListener('click', () => (el.searchBar.hidden ? openSearch() : closeSearch()));
el.searchClose.addEventListener('click', closeSearch);
el.searchPrev.addEventListener('click', () => stepHit(-1));
el.searchNext.addEventListener('click', () => stepHit(1));

let searchTimer = null;
el.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 260);
});
el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') closeSearch();
});

async function runSearch() {
  const query = el.searchInput.value.trim();
  const runToken = ++searchState.runToken;
  searchState.query = query;
  searchState.hits = [];
  searchState.index = -1;

  for (const p of state.pages) clearHighlights(p);
  if (!query || !state.pdf) { el.searchCount.textContent = ''; return; }

  const needle = query.toLowerCase();
  el.searchCount.textContent = '查找中…';

  for (const p of state.pages) {
    if (runToken !== searchState.runToken) return;

    const items = await pageTextItems(p);
    if (runToken !== searchState.runToken) return;

    let joined = '';
    const offsets = [];
    for (let i = 0; i < items.length; i++) {
      offsets.push(joined.length);
      joined += items[i].str;
    }
    const hay = joined.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      let itemIndex = 0;
      for (let i = offsets.length - 1; i >= 0; i--) {
        if (offsets[i] <= at) { itemIndex = i; break; }
      }
      searchState.hits.push({ page: p.num, itemIndex, start: at - offsets[itemIndex], length: query.length });
      from = at + Math.max(1, needle.length);
    }

    if (searchState.hits.length) {
      applyHighlights(p);
      if (p.rendered) markMatchOnPage(p);
    }
    // 让出主线程，保证滚动依然流畅
    await new Promise((r) => setTimeout(r, 0));
  }

  if (runToken !== searchState.runToken) return;
  if (!searchState.hits.length) {
    el.searchCount.textContent = '无结果';
  } else {
    searchState.index = -1;
    stepHit(1, true);
  }
}

function pageTextItems(p) {
  if (p.textItems) return Promise.resolve(p.textItems);
  if (!p.textItemsPromise) {
    p.textItemsPromise = state.pdf.getPage(p.num)
      .then((pg) => pg.getTextContent())
      .then((tc) => { p.textItems = tc.items.filter((it) => typeof it.str === 'string'); return p.textItems; })
      .catch(() => { p.textItems = []; return p.textItems; });
  }
  return p.textItemsPromise;
}

function clearHighlights(p) {
  const layer = p.textLayerDiv;
  if (!layer) return;
  for (const m of layer.querySelectorAll('mark.hl')) {
    const parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
}

/** 把该页的命中片段包进 <mark class="hl">。文本层 span 与 textContent.items 一一对应。 */
function applyHighlights(p) {
  if (!p.textLayerDiv || !searchState.query) return;
  const hits = searchState.hits.filter((h) => h.page === p.num);
  if (!hits.length) return;

  const spans = p.textLayerDiv.querySelectorAll('span');
  const byItem = new Map();
  for (const h of hits) {
    if (!byItem.has(h.itemIndex)) byItem.set(h.itemIndex, []);
    byItem.get(h.itemIndex).push(h);
  }

  for (const [itemIndex, list] of byItem) {
    const span = spans[itemIndex];
    if (!span) continue;
    const text = span.textContent;
    const parts = [];
    let cursor = 0;
    for (const h of list.sort((a, b) => a.start - b.start)) {
      if (h.start < cursor) continue;
      if (h.start > cursor) parts.push(document.createTextNode(text.slice(cursor, h.start)));
      const mark = document.createElement('mark');
      mark.className = 'hl';
      mark.textContent = text.slice(h.start, h.start + h.length);
      parts.push(mark);
      cursor = h.start + h.length;
    }
    if (cursor < text.length) parts.push(document.createTextNode(text.slice(cursor)));
    span.textContent = '';
    span.append(...parts);
  }
}

function markMatchOnPage(p) {
  const marks = p.textLayerDiv?.querySelectorAll('mark.hl') || [];
  for (const m of marks) m.classList.remove('hl-active');
  const current = searchState.hits[searchState.index];
  if (!current || current.page !== p.num) return;
  const nth = searchState.hits.filter((h) => h.page === p.num).indexOf(current);
  marks[nth]?.classList.add('hl-active');
}

function stepHit(delta, silent = false) {
  if (!searchState.hits.length) return;
  searchState.index = (searchState.index + delta + searchState.hits.length) % searchState.hits.length;
  const hit = searchState.hits[searchState.index];
  el.searchCount.textContent = `${searchState.index + 1}/${searchState.hits.length}`;

  const p = state.pages[hit.page - 1];
  if (!silent) scrollToPage(hit.page, 'smooth');
  if (!p) return;

  markMatchOnPage(p);
  const active = p.textLayerDiv?.querySelector('mark.hl-active');
  if (active) active.scrollIntoView({ block: 'center', behavior: silent ? 'auto' : 'smooth' });
  else if (!silent) scrollToPage(hit.page, 'auto');
}

/* ─────────────────────────  保存 PDF  ───────────────────────── */

el.btnDownload.addEventListener('click', () => {
  if (!state.objectUrl) return;
  const a = document.createElement('a');
  a.href = state.objectUrl;
  a.download = state.downloadName;
  document.body.append(a);
  a.click();
  a.remove();
  toast(`已导出 ${state.downloadName}`, 'ok');
});

/* ─────────────────────────  打开文件入口  ───────────────────────── */

/**
 * 打开文件选择器。
 *
 * 主路径是 <label for="fileInput">，由浏览器原生激活 —— 不依赖 JS，
 * 这在 iOS 上明显更可靠（iOS 对「程序化点击隐藏的 file input」限制很多）。
 * 这个函数只给键盘快捷键 Ctrl/⌘+O 用。
 */
function pickFile() {
  el.fileInput.value = '';
  el.fileInput.click();
}

/* label 没有原生的键盘激活行为，这里补上 Enter / 空格 */
for (const label of [el.btnOpen, el.btnOpenBig]) {
  label?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    pickFile();
  });
}

el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files?.[0];
  if (f) openFile(f);
});

let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  el.dropOverlay.hidden = false;
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.dropOverlay.hidden = true;
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.dropOverlay.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});
addEventListener('blur', () => { dragDepth = 0; el.dropOverlay.hidden = true; });

/* ─────────────────────────  键盘快捷键  ───────────────────────── */

addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); if (state.pdf) openSearch(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); pickFile(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.objectUrl) el.btnDownload.click(); return; }

  if (e.key === 'Escape') {
    if (!el.searchBar.hidden) return closeSearch();
    if (!el.progressOverlay.hidden) return el.btnCancel.click();
    if (!el.sidebar.hidden && state.pdf) return toggleSidebar(false);
    return;
  }
  if (typing || !state.pdf) return;

  switch (e.key) {
    case 'ArrowRight': case 'PageDown': case ' ': e.preventDefault(); scrollToPage(state.current + 1); break;
    case 'ArrowLeft': case 'PageUp': e.preventDefault(); scrollToPage(state.current - 1); break;
    case 'Home': e.preventDefault(); scrollToPage(1); break;
    case 'End': e.preventDefault(); scrollToPage(state.numPages); break;
    case '+': case '=': e.preventDefault(); zoomBy(1.25); break;
    case '-': case '_': e.preventDefault(); zoomBy(1 / 1.25); break;
    case '0': e.preventDefault(); zoomTo(1 / SCALE_PER_PERCENT); break;
    case 'w': e.preventDefault(); setFit('width'); break;
    default: break;
  }
});

/* ─────────────────────────  进度界面  ───────────────────────── */

function showProgress(title, detail) {
  el.progressTitle.textContent = title;
  el.progressDetail.textContent = detail || '';
  el.progressOverlay.hidden = false;
  setProgress(0);
  setIndeterminate(true);
}
function hideProgress() { el.progressOverlay.hidden = true; }
function setProgress(v) {
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  el.progressBar.style.width = `${pct}%`;
  el.progressPercent.textContent = `${pct}%`;
}
function setProgressText(t) { el.progressDetail.textContent = t; }
function setIndeterminate(on) {
  el.progressBar.parentElement.classList.toggle('is-indeterminate', on);
}

/* ─────────────────────────  关闭 / 清理  ───────────────────────── */

/** 彻底关闭当前文档（回到空状态）。多标签下的「替换打开」不走这里。 */
function closeDocument() {
  releaseActiveDocument();
  el.paneOutline.textContent = '';
  el.paneThumbs.textContent = '';
  el.pageCount.textContent = '0';
  el.pageInput.value = '1';
  el.btnDownload.disabled = true;
  el.empty.hidden = false;
  el.fileName.textContent = '未打开文件';
  el.formatBadge.hidden = true;
}

addEventListener('beforeunload', () => {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
});

/* ─────────────────────────  主题切换  ───────────────────────── */

el.btnTheme.addEventListener('click', () => {
  state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  saveSettings();
});

// 旧版 Safari 只有 addListener，没有 addEventListener；这里做兼容，
// 否则这一句会在模块顶层抛异常，把整个应用连带干掉。
{
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => { if (state.theme === 'auto') applyTheme(); };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onChange);
}

/* ─────────────────────────  窗口尺寸变化  ───────────────────────── */

let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // 侧栏形态只取决于窗口宽度，和有没有打开文档无关
    syncSidebarMode();
    if (!state.pdf) return;
    if (state.fit !== 'custom') { applyLayout(); renderVisiblePages(); }
    else updateCurrentFromScroll();
  }, 140);
});

/* ─────────────────────────  启动  ───────────────────────── */

async function boot() {
  applyTheme();

  ensureSettingsPanel();
  $('#btnSettings')?.addEventListener('click', () => app.settings.toggle());

  state.fit = settings.fit || 'width';
  state.customScale = Number(settings.scale) > 0 ? Number(settings.scale) : 1;
  state.invert = !!settings.invert;
  el.viewer.classList.toggle('invert-pages', state.invert);

  if (settings.sidebar && innerWidth >= 900) el.sidebar.hidden = false;
  if (settings.tab === 'thumbs') document.querySelector('.tab[data-tab="thumbs"]')?.click();
  syncSidebarMode();

  saveSettings();

  // 通过「文件关联 / 打开方式」启动时，浏览器会把文件交到这里（PWA 安装后可用）
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const handle = params?.files?.[0];
      if (!handle) return;
      try {
        await openFile(await handle.getFile());
      } catch (err) {
        toast(`无法读取系统传入的文件：${describeError(err)}`, 'error');
      }
    });
  }

  // 预加载 WASM：首次打开 CAJ 更快。失败也不影响 PDF 直通。
  getWasm().catch((err) => console.warn('WASM 预加载失败，CAJ 转换可能不可用', err));

  registerServiceWorker();

  // 恢复上次没关掉的标签（IndexedDB 里缓存过的文件）。失败不影响单文档使用。
  app.docs.restoreSession()
    .then(() => refreshSettingsUi())
    .catch((err) => console.warn('恢复上次的标签失败：', err));
}

function registerServiceWorker() {
  const secure = location.protocol === 'https:'
    || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!secure || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
}

/* ─────────────────────────  离线预热  ───────────────────────── */

let warmOfflineCacheBusy = false;

/** 把失败项缩成便于阅读的路径。 */
function shortCacheName(url) {
  try {
    return new URL(url, location.href).pathname;
  } catch {
    return String(url);
  }
}

/**
 * 让 Service Worker 把引擎 / 字体等大文件一次性缓存下来。
 *
 * 「装到主屏后断网也能用」这条承诺只有在 vendor 文件全部进缓存后才成立；
 * 平时只有访问过的文件才会被顺带缓存，所以需要一个显式的预热入口。
 */
async function warmOfflineCache({ timeoutMs = 900000 } = {}) {
  if (warmOfflineCacheBusy) {
    toast('离线包正在准备中，请稍候…');
    return { ok: false, busy: true, failed: [], bytes: 0, total: 0 };
  }
  const sw = navigator.serviceWorker;
  if (!sw || !isSecureContext) {
    toast('当前环境不注册 Service Worker（局域网 http 下属正常）', 'error');
    return { ok: false, failed: ['Service Worker 不可用'], bytes: 0, total: 0 };
  }

  let controller = sw.controller;
  if (!controller) {
    try { controller = (await sw.ready).active; } catch { controller = null; }
  }
  if (!controller) {
    toast('Service Worker 尚未接管页面，请刷新后重试', 'error');
    return { ok: false, failed: ['Service Worker 控制器未就绪'], bytes: 0, total: 0 };
  }

  warmOfflineCacheBusy = true;
  const result = await new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    let total = 0;
    let done = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sw.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'cache-vendor-progress') {
        total = data.total || total;
        done = data.done || done;
        toast(`离线预热中：${done}/${total || '?'}`);
      } else if (data.type === 'cache-vendor-done') {
        finish({
          ok: !!data.ok,
          failed: Array.isArray(data.failed) ? data.failed : [],
          bytes: data.bytes || 0,
          total: total || data.total || 0,
          done: done || data.total || 0,
        });
      }
    };
    timer = setTimeout(() => {
      finish({ ok: false, failed: [], bytes: 0, total, timeout: true });
    }, timeoutMs);
    sw.addEventListener('message', onMessage);
    controller.postMessage({ type: 'cache-vendor' });
  });
  warmOfflineCacheBusy = false;

  if (result.timeout) {
    toast('离线预热超时（15 分钟未完成），请检查网络后重试', 'error', 9000);
    return result;
  }
  if (result.ok) {
    toast(`离线包已就绪：${result.total || result.done || '全部'} 个文件，已可断网使用`);
    return result;
  }
  const failed = result.failed || [];
  const names = failed.slice(0, 3).map(shortCacheName).join('、');
  const more = failed.length > 3 ? ` 等 ${failed.length} 项` : '';
  toast(`离线预热未完成${names ? `，失败：${names}${more}` : ''}`, 'error', 9000);
  return result;
}

/* ─────────────────────────  环境自检  ───────────────────────── */

/**
 * 逐项检查运行环境，把结果画进 index.html 提供的诊断面板。
 *
 * iPad 上没有开发者工具，用户遇到「点了没反应」时无从下手。自检把
 * 「脚本有没有跑」「引擎能不能下载并编译」「能不能创建 Worker」这些
 * 关键前提一次性摆出来，截图就能定位问题。
 */
async function runSelfCheck() {
  const show = globalThis.__cajShowDiag || (() => {});
  const rows = [];
  const add = (label, value, bad = false) => rows.push([label, String(value), bad]);

  const secure = isSecureContext || location.protocol === 'https:'
    || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

  add('地址', location.href);
  add('协议 / 安全上下文', `${location.protocol} / ${secure ? '是' : '否（局域网 http 下正常）'}`);
  add('页面脚本', '已执行', false);

  // 1. 引擎文件能不能下载
  const wasmUrl = new URL('caj2pdf-rust/caj2pdf_wasm.wasm', VENDOR);
  let wasmBytes = 0;
  try {
    const r = await fetch(wasmUrl, { cache: 'no-store' });
    wasmBytes = (await r.arrayBuffer()).byteLength;
    add('引擎文件 (caj2pdf_wasm.wasm)', `HTTP ${r.status} · ${(wasmBytes / 1024 / 1024).toFixed(2)} MB`,
      !r.ok || wasmBytes < 100000);
  } catch (err) {
    add('引擎文件 (caj2pdf_wasm.wasm)', `下载失败：${err.message}`, true);
  }

  // 2. 能不能编译（顺带验证 MIME；失败会自动走一次性编译的兜底）
  if (wasmBytes > 100000) {
    try {
      await getWasm();
      add('引擎编译', '成功', false);
    } catch (err) {
      add('引擎编译', `失败：${err.message}`, true);
    }
  } else {
    add('引擎编译', '跳过（文件没拿到）', true);
  }

  // 3. 能不能创建模块 Worker（转换必须跑在 Worker 里）
  try {
    const worker = new Worker(new URL('caj2pdf-rust/internal/worker.js', VENDOR), { type: 'module' });
    worker.terminate();
    add('模块 Worker', '可用', false);
  } catch (err) {
    add('模块 Worker', `不可用：${err.message}`, true);
  }

  // 4. 转换所需的并发原语
  add('SharedArrayBuffer / 跨源隔离',
    `${typeof SharedArrayBuffer === 'function' ? '有' : '无'} / ${globalThis.crossOriginIsolated ? '是' : '否'}`
    + '（没有也能转换，只是取消不是即时的）');

  // 5. 存储能力（只有 C8/HN-B 的原生文字页需要）
  const opfs = typeof navigator.storage?.getDirectory === 'function';
  add('OPFS 存储', opfs ? '可用' : '不可用',
    !opfs && secure ? true : false);
  if (!opfs) {
    rows[rows.length - 1][1] += '（仅影响 C8/HN-B 的原生文字页，其它格式不受影响）';
  }

  // 6. PDF.js 的解码器与字符映射表
  for (const [label, path] of [
    ['PDF.js JBIG2 解码器', 'pdfjs/wasm/jbig2.wasm'],
    ['中文 CMap', 'pdfjs/cmaps/UniGB-UCS2-H.bcmap'],
  ]) {
    try {
      const r = await fetch(new URL(path, VENDOR));
      add(label, `HTTP ${r.status}`, !r.ok);
    } catch (err) {
      add(label, `失败：${err.message}`, true);
    }
  }

  // 7. 离线可用性（Service Worker 只在安全上下文注册）
  const swUsable = 'serviceWorker' in navigator && secure;
  let cachedOffline = 0;
  if (swUsable) {
    try {
      const names = await caches.keys();
      const vendorName = names.find((n) => n.startsWith('caj-viewer-') && n.endsWith('-vendor'));
      if (vendorName) cachedOffline = (await (await caches.open(vendorName)).keys()).length;
    } catch { /* 统计失败不影响其它项 */ }
    // 未预热时缓存为空是正常情况，这一项永远不标红。
    add('离线缓存', cachedOffline > 0
      ? `已缓存 ${cachedOffline} 项（已可断网使用）`
      : '尚未缓存（可点下方按钮预热）', false);
  } else {
    add('离线缓存', '不适用（局域网 http 下不注册 Service Worker）', false);
  }

  // 8. 浏览器能力
  add('用户代理', navigator.userAgent);

  const problems = rows.filter((r) => r[2]);
  const tips = problems.length
    ? [
        '红字那几项就是原因。若「引擎文件」下载失败，多半是 vendor/ 没传全。',
        '若「模块 Worker」不可用，说明浏览器过旧，请升级 iPadOS。',
        '点「复制诊断信息」把结果发出来即可定位。',
      ]
    : [
        '所有前提都满足，问题可能出在具体文件上。试着换一个 CAJ 再打开。',
        '若打开文件时弹出中文错误提示，提示内容本身就是原因。',
      ];
  if (swUsable && cachedOffline > 0) {
    tips.push('离线包已就绪，已可断网使用。');
  } else if (swUsable) {
    tips.push('点下方「预热离线包」把引擎和字体缓存到本机，之后断网也能打开。');
  }
  show({
    title: problems.length ? `环境自检：${problems.length} 项有问题` : '环境自检：全部通过',
    rows,
    tips,
    actions: swUsable
      ? [{
          label: '预热离线包',
          busyLabel: '预热中…',
          onClick: () => warmOfflineCache().then((r) => (r.ok ? '已完成' : '未完成')),
        }]
      : undefined,
  });

  // 设置面板的「诊断」分区直接消费这个结构（rows 是 [名称, 值, 是否异常] 三元组）
  return { rows, tips };
}

el.btnSelfCheck?.addEventListener('click', () => {
  runSelfCheck().catch((err) => toast(`自检失败：${err.message}`, 'error'));
});

/* 自动化测试与调试用的最小接口。不影响正常使用。 */
globalThis.__caj = {
  openFile,
  openPdfInTab,
  rotate,
  docs: app.docs,
  get settings() { return app.settings; },
  app: appFacade,
  get pinch() { return pinchApi; },
  get state() { return state; },
  get activeDocument() { return activeDoc; },
  get pagesEl() { return pagesEl; },
  scrollToPage,
  setFit,
  zoomTo,
  openSearch,
  closeSearch,
  runSearch,
  renderPage,
  renderVisiblePages,
  prunePages,
  releasePage,
  runSelfCheck,
  warmOfflineCache,
  clearRecentFiles,
};

// boot 出错也要让用户看得见 —— 否则又是一次「界面在但点不动」的静默失败
boot().catch((err) => {
  console.error('启动失败', err);
  const show = globalThis.__cajShowDiag;
  if (!show) { toast(`启动失败：${err.message}`, 'error', 15000); return; }
  show({
    title: '应用启动失败',
    rows: [
      ['错误', err?.message || String(err), true],
      ['地址', location.href],
      ['用户代理', navigator.userAgent],
    ],
    tips: ['点「运行环境自检」可以进一步定位；点「复制诊断信息」把结果发出来。'],
  });
});
