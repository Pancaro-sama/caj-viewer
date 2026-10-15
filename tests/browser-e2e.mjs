/* ==========================================================================
 * CAJ 阅读器 — 真实浏览器端到端测试
 *
 * 启动本地静态服务 + 无头 Chrome（CDP 直连，无需任何 npm 依赖），
 * 在真实浏览器里跑完整流程：CAJ → 转换 → 渲染 → 目录 → 查找 → 导出。
 *
 *   node tests/browser-e2e.mjs
 *
 * 产物截图写入 tests/out/e2e/。
 * ========================================================================== */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'tests', 'out', 'e2e');
const BASE_PREFIX = 'http://127.0.0.1:';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : null,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/* ─────────────────────────  小工具  ───────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让操作系统分配一个空闲端口，避免撞上本机其它开发服务。 */
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** 等 Chrome 把真实的调试端口写进 profile 目录（用 --remote-debugging-port=0）。 */
async function waitForDevToolsPort(profile, timeoutMs = 25000) {
  const file = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      const [port] = (await readFile(file, 'utf8')).split('\n');
      if (Number(port) > 0) return Number(port);
    }
    if (Date.now() > deadline) throw new Error('Chrome 未能在超时时间内写出 DevTools 端口');
    await sleep(150);
  }
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json().catch(() => true);
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error(`等待超时：${url}`);
    await sleep(120);
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ─────────────────────────  极简 CDP 客户端  ───────────────────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${p.method})`));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
    // 浏览器崩了/连接断了，必须让所有挂起的请求立刻失败：
    // 否则 waitFor 里的 eval 永远不返回，整个 e2e 会静默挂死（曾经挂了 20 小时）。
    const failAll = (why) => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`CDP 连接已断开（${why}）：${p.method}`));
        this.pending.delete(id);
      }
    };
    ws.addEventListener('close', () => failAll('websocket closed'));
    ws.addEventListener('error', () => failAll('websocket error'));
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 120000) {
    const id = ++this.id;
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 请求超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve_, reject, method, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  /** 在页面里求值，返回可结构化克隆的值。 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面内异常：${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }

  /** 轮询等待页面内条件成立。 */
  async waitFor(expression, { timeout = 30000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const ok = await this.eval(`return !!(${expression});`).catch(() => false);
      if (ok) return true;
      if (Date.now() > deadline) throw new Error(`等待条件超时：${label}`);
      await sleep(150);
    }
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  }
}

/* ─────────────────────────  主流程  ───────────────────────── */

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge。设置 CHROME_PATH 环境变量后重试。');
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'caj-e2e-'));

let server = null;
let chrome = null;
let cdp = null;

const consoleErrors = [];
const pageErrors = [];
const allConsole = [];

try {
  /* 1. 起本地静态服务（stdio 必须不是 pipe：沙箱下命名管道不可用） */
  const PORT = Number(process.env.E2E_PORT) || await freePort();
  const BASE = `${BASE_PREFIX}${PORT}`;

  server = spawn(process.execPath, ['serve.js', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
  });
  await waitForHttp(`${BASE}/index.html`);

  // 确认监听该端口的确实是我们的服务，而不是本机其它项目
  const shell = await (await fetch(`${BASE}/index.html`)).text();
  if (!shell.includes('CAJ 阅读器')) {
    throw new Error(`端口 ${PORT} 上运行的不是 CAJ 阅读器，请换端口或关闭占用进程`);
  }
  console.log(`静态服务已就绪：${BASE}\n`);

  /* 2. 起无头 Chrome（调试端口交给系统分配，再从 profile 目录读回） */
  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,BackForwardCache',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--window-size=1280,860',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const cdpPort = await waitForDevToolsPort(profile);
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的浏览器页面目标');

  cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    allConsole.push(`${p.type}: ${text}`);
    if (p.type === 'error') consoleErrors.push(text);
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry;
    const text = `[${e.source}] ${e.text}${e.url ? ` @ ${e.url}` : ''}`;
    allConsole.push(text);
    if (e.level === 'error') consoleErrors.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
  });

  /* 3. 打开应用（桌面视口） */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 860, deviceScaleFactor: 2, mobile: false,
  });

  const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.navigate', { url: `${BASE}/index.html` });
  await loaded;
  await cdp.waitFor('window.__caj && window.__caj.state', { label: '应用启动' });

  /** 重新加载页面（用于模拟「直接以窄屏打开」）。 */
  const reload = async () => {
    const done = new Promise((res) => cdp.on('Page.loadEventFired', res));
    await cdp.send('Page.reload', { ignoreCache: false });
    await done;
    await cdp.waitFor('window.__caj && window.__caj.state', { label: '应用重新启动' });
  };

  const boot = await cdp.eval(`
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      title: document.title,
      hasWorker: typeof Worker !== 'undefined',
      sw: 'serviceWorker' in navigator,
      emptyVisible: !document.querySelector('#empty').hidden,
      searchBarDisplay: getComputedStyle(document.querySelector('#searchBar')).display,
      toastDisplay: getComputedStyle(document.querySelector('#toast')).display,
      modalDisplay: getComputedStyle(document.querySelector('#progressOverlay')).display,
      dropDisplay: getComputedStyle(document.querySelector('#dropOverlay')).display,
    };
  `);
  check('应用外壳加载成功', boot.title.includes('CAJ'), boot.title);
  check('跨源隔离已生效（SharedArrayBuffer 可用）', boot.crossOriginIsolated, String(boot.crossOriginIsolated));
  check('初始显示空状态', boot.emptyVisible);
  // 这些浮层用了 display:flex，若不显式处理 [hidden] 就会一直挡在页面上
  check('初始时查找栏 / 进度框 / 拖放遮罩均不可见',
    boot.searchBarDisplay === 'none' && boot.modalDisplay === 'none'
    && boot.dropDisplay === 'none' && boot.toastDisplay === 'none',
    `search=${boot.searchBarDisplay} modal=${boot.modalDisplay} drop=${boot.dropDisplay} toast=${boot.toastDisplay}`);

  /* 打开文件这条路必须在 iPad 上走得通 */
  const picker = await cdp.eval(`
    const input = document.querySelector('#fileInput');
    const big = document.querySelector('#btnOpenBig');
    const top = document.querySelector('#btnOpen');
    const cs = input ? getComputedStyle(input) : null;
    return {
      hasInput: !!input,
      display: cs ? cs.display : null,
      opacity: cs ? cs.opacity : null,
      accept: input ? input.getAttribute('accept') : 'MISSING',
      bigTag: big ? big.tagName : null,
      bigFor: big ? big.getAttribute('for') : null,
      topTag: top ? top.tagName : null,
      topFor: top ? top.getAttribute('for') : null,
      labelCount: document.querySelectorAll('label[for="fileInput"]').length,
    };
  `);
  check('文件输入不是 display:none（iOS 上否则点了不会弹选择器）',
    picker.hasInput && picker.display !== 'none' && picker.opacity === '0',
    `display=${picker.display} opacity=${picker.opacity}`);
  check('打开文件走 <label for> 原生激活，不依赖 JS 调用 input.click()',
    picker.bigTag === 'LABEL' && picker.bigFor === 'fileInput'
    && picker.topTag === 'LABEL' && picker.topFor === 'fileInput' && picker.labelCount === 2,
    `空状态=${picker.bigTag} 工具栏=${picker.topTag} label 数=${picker.labelCount}`);
  check('刻意不设置 accept（否则 iOS 会把 .caj 置灰）',
    picker.accept === null, `accept=${picker.accept}`);

  /* 老 iPad 兼容垫片：把较新的标准方法删掉再重载，
     必须由 app/compat.js 补回来，并且应用仍能正常启动。
     相当于在本机演示「Safari 16.4 之前的 iPadOS」上会发生什么——
     没有这层垫片时，pdf.js 6.x 会在加载文档时才报
     "Promise.withResolvers is not a function"，用户只看到点开没反应。 */
  await cdp.eval(`
    globalThis.__cajCompatNative = {
      withResolvers: typeof Promise.withResolvers,
      fromBase64: typeof Uint8Array.fromBase64,
      fromHex: typeof Uint8Array.fromHex,
      hasOwn: typeof Object.hasOwn,
      atType: typeof Array.prototype.at,
      findLastType: typeof Array.prototype.findLast,
    };
    try { delete Promise.withResolvers; } catch (e) {}
    try { delete Uint8Array.fromBase64; } catch (e) {}
    try { delete Uint8Array.fromHex; } catch (e) {}
    try { delete Object.hasOwn; } catch (e) {}
    try { delete Array.prototype.at; } catch (e) {}
    try { delete Array.prototype.findLast; } catch (e) {}
    window.__cajCompatRemoved = {
      withResolvers: typeof Promise.withResolvers,
      fromBase64: typeof Uint8Array.fromBase64,
      fromHex: typeof Uint8Array.fromHex,
      hasOwn: typeof Object.hasOwn,
      atType: typeof Array.prototype.at,
      findLastType: typeof Array.prototype.findLast,
    };
    return window.__cajCompatRemoved;
  `);
  await reload();
  const compat = await cdp.eval(`
    let shimOn = null;
    try {
      const r = document.querySelector('script[src*="compat"]');
      shimOn = !!r;
    } catch (e) { shimOn = false; }
    const pdfjsOk = await (async () => {
      try {
        const mod = await import('/vendor/pdfjs/build/pdf.min.js');
        return typeof mod.getDocument === 'function';
      } catch (e) { return 'import-failed: ' + e.message; }
    })();
    /* 真的用一次被垫回来的方法，确认行为正确而不只是存在 */
    let behavior = null;
    try {
      const bytes = Uint8Array.fromBase64('SGVsbG8=');
      behavior = { text: String.fromCharCode(...bytes), at: [1, 2, 3].at(-1), hasOwn: Object.hasOwn({ a: 1 }, 'a') };
    } catch (e) { behavior = 'failed: ' + e.message; }
    return {
      shimOn,
      promiseWithResolvers: typeof Promise.withResolvers,
      fromBase64: typeof Uint8Array.fromBase64,
      fromHex: typeof Uint8Array.fromHex,
      hasOwn: typeof Object.hasOwn,
      atType: typeof Array.prototype.at,
      findLastType: typeof Array.prototype.findLast,
      pdfjsOk,
      behavior,
      leftover: globalThis.__cajPolyfillLeftover,
      booted: !!(window.__caj && window.__caj.state),
    };
  `);
  check('缺少新标准方法时 app/compat.js 会补回来（老 iPad 的关键）',
    compat.shimOn && compat.promiseWithResolvers === 'function'
    && compat.fromBase64 === 'function' && compat.fromHex === 'function'
    && compat.hasOwn === 'function' && compat.atType === 'function'
    && compat.findLastType === 'function',
    `withResolvers=${compat.promiseWithResolvers} fromBase64=${compat.fromBase64} hasOwn=${compat.hasOwn} at=${compat.atType} findLast=${compat.findLastType}`);
  check('垫片补的方法行为正确（base64 解码 / at 负索引 / hasOwn）',
    compat.behavior && compat.behavior.text === 'Hello' && compat.behavior.at === 3 && compat.behavior.hasOwn === true,
    JSON.stringify(compat.behavior));
  check('补齐后 pdf.js 仍可加载，应用仍能启动',
    compat.pdfjsOk === true && compat.booted === true,
    `getDocument=${compat.pdfjsOk} booted=${compat.booted}`);

  /* 环境自检 */
  const selfCheck = await cdp.eval(`
    await window.__caj.runSelfCheck();
    const panel = document.querySelector('#caj-diag');
    if (!panel) return { shown: false };
    const tds = [...panel.querySelectorAll('td')];
    return {
      shown: true,
      title: panel.querySelector('h2').textContent,
      badCount: tds.filter((td) => td.style.fontWeight === '600').length,
      text: panel.textContent,
    };
  `);
  check('环境自检可运行，并且在本机环境下全部通过',
    selfCheck.shown && selfCheck.title.includes('全部通过') && selfCheck.badCount === 0,
    `${selfCheck.title || '面板未出现'}（红字项 ${selfCheck.badCount}）`);
  check('自检确实检查了引擎文件与 Worker',
    selfCheck.text?.includes('caj2pdf_wasm.wasm') && selfCheck.text?.includes('模块 Worker'), '');
  await cdp.screenshot(join(OUT, '13-self-check.png'));
  await cdp.eval("window.__cajHideDiag(); return 1;");
  check('自检面板可以关闭', await cdp.eval("return !document.querySelector('#caj-diag');"));
  await cdp.screenshot(join(OUT, '01-empty-desktop.png'));

  /* 4. 打开 CAJ：转换 + 渲染 */
  console.log('\n— 场景 A：打开 CAJ 文件 —');
  const cajInfo = await cdp.eval(`
    const buf = await (await fetch('/tests/fixtures/sample.caj')).arrayBuffer();
    const file = new File([buf], 'sample.caj', { type: 'application/octet-stream' });
    await window.__caj.openFile(file);
    return { size: buf.byteLength };
  `);
  check('CAJ 夹具读取成功', cajInfo.size === 1776, `${cajInfo.size} 字节`);

  await cdp.waitFor('window.__caj.state.numPages === 2', { label: 'CAJ 解析出 2 页' });
  await cdp.waitFor("document.querySelector('.page canvas') && document.querySelectorAll('.page canvas').length >= 1",
    { label: '首页完成渲染' });
  await sleep(600);

  const cajView = await cdp.eval(`
    const s = window.__caj.state;
    const badges = document.querySelector('#formatBadge');
    const pages = [...document.querySelectorAll('.page')];
    const canvases = [...document.querySelectorAll('.page canvas')];

    // 采样首屏 canvas，确认真的画了东西（不是一片纯白）
    function stats(c) {
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      let nonWhite = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 37) {
        n++;
        const r = d[i], g = d[i+1], b = d[i+2];
        if (r < 250 || g < 250 || b < 250) nonWhite++;
        seen.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
      }
      return { nonWhite, n, colors: seen.size, w: c.width, h: c.height };
    }

    return {
      numPages: s.numPages,
      format: s.format,
      badge: badges.textContent,
      badgeHidden: badges.hidden,
      pageCountText: document.querySelector('#pageCount').textContent,
      pageDivs: pages.length,
      canvasCount: canvases.length,
      first: canvases[0] ? stats(canvases[0]) : null,
      second: canvases[1] ? stats(canvases[1]) : null,
      textLayerSpans: document.querySelectorAll('.textLayer span').length,
      emptyHidden: document.querySelector('#empty').hidden,
      progressHidden: document.querySelector('#progressOverlay').hidden,
    };
  `);

  check('识别格式为 CAJ', cajView.format === 'caj' && cajView.badge === 'CAJ', `${cajView.format}/${cajView.badge}`);
  check('页数为 2', cajView.numPages === 2 && /2/.test(cajView.pageCountText), cajView.pageCountText);
  check('DOM 生成 2 个页面容器', cajView.pageDivs === 2 && cajView.canvasCount === 2);
  check('第 1 页渲染出内容',
    cajView.first && cajView.first.colors > 3 && cajView.first.nonWhite > cajView.first.n / 50,
    cajView.first ? `${cajView.first.colors} 种颜色 / ${cajView.first.nonWhite}/${cajView.first.n} 非白像素` : '无画布');
  check('第 2 页渲染出内容',
    cajView.second && cajView.second.colors > 3,
    cajView.second ? `${cajView.second.colors} 种颜色` : '无画布');
  check('文本层已生成（可选中/可查找）', cajView.textLayerSpans > 0, `${cajView.textLayerSpans} 个 span`);
  check('进度遮罩已关闭', cajView.progressHidden);
  check('空状态已隐藏', cajView.emptyHidden);

  /* 5. 目录 */
  await cdp.waitFor("document.querySelectorAll('#paneOutline .olink').length > 0", { label: '目录生成' });
  const outline = await cdp.eval(`
    const links = [...document.querySelectorAll('#paneOutline .olink')];
    return { count: links.length, titles: links.map(a => a.textContent.trim()) };
  `);
  check('CAJ 书签出现在目录中', outline.count === 1 && outline.titles[0].startsWith('Intro'),
    JSON.stringify(outline.titles));

  /* 5b. 缩略图面板 */
  const thumbs = await cdp.eval(`
    document.querySelector('.tab[data-tab="thumbs"]').click();
    await new Promise(r => setTimeout(r, 1600));
    const cs = [...document.querySelectorAll('.thumb-canvas')];
    const painted = cs.filter(c => c.width > 20 && c.height > 20).length;
    document.querySelector('.tab[data-tab="outline"]').click();
    return { count: cs.length, painted };
  `);
  check('缩略图面板为每页渲染出小图', thumbs.count === 2 && thumbs.painted === 2, JSON.stringify(thumbs));

  await cdp.screenshot(join(OUT, '02-caj-desktop.png'));

  /* 6. 导出 PDF */
  const exportInfo = await cdp.eval(`
    const blob = await (await fetch(window.__caj.state.objectUrl)).blob();
    const head = new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer());
    return { size: blob.size, type: blob.type, head };
  `);
  check('导出的 PDF 有效', exportInfo.head === '%PDF-' && exportInfo.size > 500,
    `${exportInfo.size} 字节, 头部 ${JSON.stringify(exportInfo.head)}`);

  /* 7. 查找 */
  console.log('\n— 场景 B：查找 —');
  const search = await cdp.eval(`
    document.querySelector('#btnSearch').click();
    document.querySelector('#searchInput').value = 'CAJ page';
    window.__caj.runSearch();
    for (let i = 0; i < 60 && document.querySelector('#searchCount').textContent === '查找中…'; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    return {
      count: document.querySelector('#searchCount').textContent,
      marks: document.querySelectorAll('mark.hl').length,
      barVisible: !document.querySelector('#searchBar').hidden,
    };
  `);
  check('查找栏可打开', search.barVisible);
  check('查找命中并高亮', search.marks >= 2 && /\d+\/\d+/.test(search.count),
    `计数=${search.count}, 高亮=${search.marks}`);
  await cdp.screenshot(join(OUT, '03-search.png'));
  await cdp.eval("window.__caj.closeSearch(); return 1;");

  /* 8. PDF 直通 */
  console.log('\n— 场景 C：打开 PDF（直通，不经转换器）—');
  await cdp.eval(`
    const buf = await (await fetch('/tests/fixtures/sample.pdf')).arrayBuffer();
    await window.__caj.openFile(new File([buf], 'sample.pdf', { type: 'application/pdf' }));
    return 1;
  `);
  await cdp.waitFor('window.__caj.state.numPages === 1', { label: 'PDF 打开 1 页' });
  await cdp.waitFor("document.querySelector('.page canvas')", { label: 'PDF 渲染' });

  // 文本层是渲染完成之后异步挂上去的；等不到就取一份完整诊断，别只是干等
  try {
    await cdp.waitFor("document.querySelectorAll('.textLayer span').length > 0",
      { label: 'PDF 文本层挂载', timeout: 8000 });
  } catch { /* 下面的诊断会说明原因 */ }

  const pdfDiag = await cdp.eval(`
    const page = await window.__caj.state.pdf.getPage(1);
    const tc = await page.getTextContent();
    const layer = document.querySelector('.textLayer');
    return {
      itemCount: tc.items.length,
      firstStrs: tc.items.filter(i => typeof i.str === 'string').map(i => i.str).slice(0, 8),
      hasLayerDiv: !!layer,
      layerChildren: layer ? layer.children.length : -1,
      layerHTML: layer ? layer.innerHTML.slice(0, 240) : '',
      spans: document.querySelectorAll('.textLayer span').length,
      divs: document.querySelectorAll('.textLayer div').length,
    };
  `);
  console.log('  · PDF 文本层诊断：', JSON.stringify(pdfDiag));
  await sleep(200);

  const pdfView = await cdp.eval(`
    const s = window.__caj.state;
    const c = document.querySelector('.page canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 37) seen.add((d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4));
    return {
      numPages: s.numPages, format: s.format,
      badge: document.querySelector('#formatBadge').textContent,
      colors: seen.size,
      text: [...document.querySelectorAll('.textLayer span')].map(x => x.textContent).join(''),
    };
  `);
  check('PDF 直通：格式徽章为 PDF', pdfView.format === 'pdf' && pdfView.badge === 'PDF', pdfView.badge);
  check('PDF 直通：页数为 1', pdfView.numPages === 1);
  check('PDF 渲染出内容', pdfView.colors > 3, `${pdfView.colors} 种颜色`);
  check('PDF 文本层可提取文字', pdfView.text.includes('Hello'), JSON.stringify(pdfView.text.slice(0, 40)));

  /* 9. 错误处理 */
  console.log('\n— 场景 D：错误处理 —');
  await cdp.eval(`
    const file = new File([new Uint8Array([1,2,3,4,5,6,7,8]).buffer], 'junk.caj');
    await window.__caj.openFile(file);
    return 1;
  `);
  await sleep(900);
  const errView = await cdp.eval(`
    const t = document.querySelector('#toast');
    return { text: t.textContent, visible: !t.hidden, isError: t.classList.contains('is-error'),
             progressHidden: document.querySelector('#progressOverlay').hidden };
  `);
  check('无法识别的文件给出中文错误提示', errView.visible && errView.isError && errView.text.includes('打开失败'),
    errView.text);
  check('出错后进度遮罩被收起', errView.progressHidden);

  // 清掉上个场景残留的提示与浮层，保证后面的截图干净
  await cdp.eval("document.querySelector('#toast').hidden = true; window.__caj.closeSearch(); return 1;");

  /* 10. iPad 视口回归 */
  console.log('\n— 场景 E：iPad 竖屏布局 —');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 820, height: 1180, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    platform: 'iPad',
  });
  await cdp.eval(`
    const buf = await (await fetch('/tests/fixtures/sample.caj')).arrayBuffer();
    await window.__caj.openFile(new File([buf], 'sample.caj'));
    return 1;
  `);
  await cdp.waitFor('window.__caj.state.numPages === 2', { label: 'iPad 视口下打开 CAJ' });
  await cdp.waitFor("document.querySelector('.page canvas')", { label: 'iPad 视口下渲染' });
  await sleep(700);

  const ipad = await cdp.eval(`
    const wrap = document.querySelector('#viewerWrap');
    const page = document.querySelector('.page');
    const toolbar = document.querySelector('#toolbar');
    return {
      wrapWidth: wrap.clientWidth,
      pageWidth: page.getBoundingClientRect().width,
      toolbarBottom: toolbar.getBoundingClientRect().bottom,
      pageTop: page.getBoundingClientRect().top,
      bodyOverflow: getComputedStyle(document.body).overflow,
      pageCount: document.querySelector('#pageCount').textContent,
      bg: getComputedStyle(document.querySelector('#viewer')).backgroundColor,
    };
  `);
  check('iPad 视口下页面宽度≈容器宽度（适应宽度生效）',
    Math.abs(ipad.pageWidth - (ipad.wrapWidth - 32)) <= 4,
    `页宽 ${Math.round(ipad.pageWidth)} / 容器 ${ipad.wrapWidth}`);
  check('iPad 视口下页面未被工具栏遮挡', ipad.pageTop >= ipad.toolbarBottom - 1,
    `pageTop=${Math.round(ipad.pageTop)} toolbarBottom=${Math.round(ipad.toolbarBottom)}`);
  check('iPad 视口下页数正确', /2/.test(ipad.pageCount), ipad.pageCount);
  check('页面本身不滚动（滚动交给阅读区）', ipad.bodyOverflow === 'hidden', ipad.bodyOverflow);
  await cdp.screenshot(join(OUT, '04-caj-ipad.png'));

  /* 侧栏在窄屏应为抽屉（先确保它是打开状态） */
  const drawer = await cdp.eval(`
    const sb = document.querySelector('#sidebar');
    if (sb.hidden) { document.querySelector('#btnSidebar').click(); }
    await new Promise(r => setTimeout(r, 300));
    return {
      visible: !sb.hidden,
      overlay: sb.classList.contains('is-overlay'),
      scrim: !document.querySelector('#sidebarScrim').hidden,
      wrapWidth: document.querySelector('#viewerWrap').clientWidth,
      viewportWidth: window.innerWidth,
    };
  `);
  check('窄屏侧栏为浮层抽屉（不挤压正文）',
    drawer.visible && drawer.overlay && drawer.scrim && drawer.wrapWidth === drawer.viewportWidth,
    JSON.stringify(drawer));
  await sleep(300);
  await cdp.screenshot(join(OUT, '05-ipad-sidebar.png'));
  await cdp.eval("document.querySelector('#sidebarScrim').click(); return 1;");

  /* 11. 深色主题 + 反色 */
  await cdp.eval("document.querySelector('#btnTheme').click(); return 1;");
  await sleep(300);
  const theme = await cdp.eval("return document.documentElement.dataset.theme;");
  check('可切换到深色主题', theme === 'dark', theme);
  await cdp.screenshot(join(OUT, '06-ipad-dark.png'));
  await cdp.eval("document.querySelector('#btnTheme').click(); return 1;");

  /* 12. 缩放 / 适应整页 */
  await cdp.eval("window.__caj.setFit('page'); return 1;");
  await sleep(700);
  const fitPage = await cdp.eval(`
    const page = document.querySelector('.page');
    const v = document.querySelector('#viewer');
    return { pageH: page.getBoundingClientRect().height, viewH: v.clientHeight };
  `);
  check('适应整页：页高不超过视口高', fitPage.pageH <= fitPage.viewH + 2,
    `${Math.round(fitPage.pageH)} / ${fitPage.viewH}`);
  await cdp.screenshot(join(OUT, '07-ipad-fit-page.png'));

  /* 12b. 放大后阅读区可滚动，且惰性渲染仍在生效 */
  await cdp.eval('window.__caj.zoomTo(6); return 1;');
  await sleep(800);
  const scrolled = await cdp.eval(`
    const v = document.querySelector('#viewer');
    v.scrollTop = 500;
    v.scrollLeft = 200;
    await new Promise(r => setTimeout(r, 400));
    return {
      scrollHeight: v.scrollHeight,
      clientHeight: v.clientHeight,
      scrollTop: Math.round(v.scrollTop),
      scrollWidth: v.scrollWidth,
      clientWidth: v.clientWidth,
      scrollLeft: Math.round(v.scrollLeft),
      liveCanvases: document.querySelectorAll('.page canvas').length,
    };
  `);
  check('放大后可纵向滚动',
    scrolled.scrollHeight > scrolled.clientHeight && scrolled.scrollTop > 0,
    `内容 ${scrolled.scrollHeight} / 视口 ${scrolled.clientHeight} / scrollTop ${scrolled.scrollTop}`);
  check('超宽页面可横向滚动',
    scrolled.scrollWidth > scrolled.clientWidth && scrolled.scrollLeft > 0,
    `内容宽 ${scrolled.scrollWidth} / 视口宽 ${scrolled.clientWidth} / scrollLeft ${scrolled.scrollLeft}`);
  check('惰性渲染生效：未把全部页面都塞进内存',
    scrolled.liveCanvases <= 16 && scrolled.liveCanvases >= 1,
    `${scrolled.liveCanvases} 个画布存活`);
  await cdp.screenshot(join(OUT, '08-ipad-zoomed.png'));

  /* 12c. iPad 冷启动：页面直接以窄屏加载，侧栏应默认收起 */
  await cdp.eval("window.__caj.setFit('width'); return 1;");
  await reload();
  const cold = await cdp.eval(`
    return {
      sidebarHidden: document.querySelector('#sidebar').hidden,
      emptyVisible: !document.querySelector('#empty').hidden,
      wrapWidth: document.querySelector('#viewerWrap').clientWidth,
      viewportWidth: window.innerWidth,
      searchHidden: getComputedStyle(document.querySelector('#searchBar')).display === 'none',
    };
  `);
  check('iPad 冷启动：侧栏默认收起、正文占满宽度、且无残留浮层',
    cold.sidebarHidden && cold.wrapWidth === cold.viewportWidth
    && cold.emptyVisible && cold.searchHidden,
    JSON.stringify(cold));
  await cdp.screenshot(join(OUT, '09-ipad-cold-start.png'));

  /* 12d. 冷启动后打开 CAJ，布局与文本层仍正常 */
  await cdp.eval(`
    const buf = await (await fetch('/tests/fixtures/sample.caj')).arrayBuffer();
    await window.__caj.openFile(new File([buf], 'sample.caj'));
    return 1;
  `);
  await cdp.waitFor('window.__caj.state.numPages === 2', { label: '冷启动后打开 CAJ' });
  await cdp.waitFor("document.querySelectorAll('.textLayer span').length > 0", { label: '冷启动后文本层' });
  await sleep(400);
  const coldCaj = await cdp.eval(`
    const wrap = document.querySelector('#viewerWrap');
    const page = document.querySelector('.page');
    return {
      pages: window.__caj.state.numPages,
      spans: document.querySelectorAll('.textLayer span').length,
      pageWidth: Math.round(page.getBoundingClientRect().width),
      expect: wrap.clientWidth - 32,
    };
  `);
  check('iPad 冷启动后打开 CAJ：布局与文本层均正常',
    coldCaj.pages === 2 && coldCaj.spans > 0 && Math.abs(coldCaj.pageWidth - coldCaj.expect) <= 4,
    JSON.stringify(coldCaj));
  await cdp.screenshot(join(OUT, '10-ipad-cold-caj.png'));

  /* ─────── 场景 F：长文档滚动 —— 滚过的每一页都必须真的画出内容 ─────── */
  console.log('\n— 场景 F：长文档滚动 —');

  const AUDIT = `
    const v = document.querySelector('#viewer');
    const vt = v.getBoundingClientRect().top;
    const vb = vt + v.clientHeight;
    const out = [];
    for (const el of document.querySelectorAll('.page')) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= vt + 4 || r.top >= vb - 4) continue;
      const c = el.querySelector('canvas');
      let colors = 0;
      if (c && c.width > 1 && c.height > 1) {
        // 只读取四个角 + 中心的小方块：整张 getImageData 会让无头 GPU 做一次大回读，
        // 在 2 倍 DPR 的长文档场景下曾经把渲染进程卡住 45 秒以上（是量法的问题，不是应用的问题）。
        const ctx = c.getContext('2d');
        const seen = new Set();
        const w = Math.min(16, c.width);
        const h = Math.min(16, c.height);
        const spots = [[0, 0], [c.width - w, 0], [0, c.height - h], [c.width - w, c.height - h],
          [(c.width - w) >> 1, (c.height - h) >> 1]];
        for (const [sx, sy] of spots) {
          const d = ctx.getImageData(sx, sy, w, h).data;
          for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
        }
        colors = seen.size;
      }
      out.push({
        num: Number(el.dataset.page),
        hasCanvas: !!c,
        colors,
        spans: el.querySelectorAll('.textLayer span').length,
      });
    }
    return out;
  `;

  /** 等可见页面都渲染完再取审计结果；真渲染不出来就会一直等到超时。 */
  async function auditVisible(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await cdp.eval(AUDIT);
      const blank = rows.filter((r) => !r.hasCanvas || r.colors <= 3);
      if (!blank.length || Date.now() > deadline) return rows;
      await sleep(150);
    }
  }

  /** 从头滚到尾，记录所有「看得见却没画出来」的页面。 */
  async function scrollThrough({ step = 0.8, maxSteps = 140 } = {}) {
    const problems = new Map();
    const visited = new Set();
    let firstBadSnapshot = null;
    await cdp.eval("document.querySelector('#viewer').scrollTop = 0; return 1;");
    await sleep(450);

    const seenColors = new Map();
    for (let i = 0; i < maxSteps; i++) {
      for (const row of await auditVisible()) {
        visited.add(row.num);
        // 每页只回读一次像素：同一页反复 getImageData 会把无头渲染进程卡死。
        let colors = seenColors.get(row.num);
        if (colors === undefined) { colors = row.colors; seenColors.set(row.num, colors); }
        const bad = !row.hasCanvas || colors <= 3 || row.spans === 0;
        if (bad && !problems.has(row.num)) {
          problems.set(row.num, { ...row, colors });
          // 抓到第一个异常页时，立刻采一份现场：再手动调一次 renderPage，
          // 就能区分「观察器根本没通知」和「通知了但渲染失败」。
          if (!firstBadSnapshot) firstBadSnapshot = await cdp.eval(`
            const s = window.__caj.state;
            const v = document.querySelector('#viewer');
            const p = s.pages[${row.num} - 1];
            const snap = (o) => ({
              rendered: o.rendered, canvas: !!o.canvas, busy: !!o.renderTask,
              pdfPage: !!o.pdfPage, viewport: o.viewport ? Math.round(o.viewport.height) : null,
              scale: o.scale, token: o.renderToken, height: o.div.offsetHeight,
            });
            const before = snap(p);
            const global = {
              current: s.current, scrollTop: Math.round(v.scrollTop),
              scrollHeight: v.scrollHeight, clientHeight: v.clientHeight,
              renderedPages: s.pages.filter((x) => x.rendered).length,
              total: s.pages.length,
              offsetTop: p.div.offsetTop,
            };
            window.__caj.renderPage(p);
            await new Promise((r) => setTimeout(r, 1800));
            return { page: ${row.num}, before, global, after: snap(p) };
          `);
        }
      }
      const moved = await cdp.eval(`
        const v = document.querySelector('#viewer');
        const before = v.scrollTop;
        v.scrollTop = Math.min(v.scrollHeight, v.scrollTop + v.clientHeight * ${step});
        await new Promise(r => setTimeout(r, 240));
        return { before, after: Math.round(v.scrollTop) };
      `);
      if (moved.after <= moved.before + 1) break;
      // 每 2 步报一次进度：万一页面卡住，日志能指出卡在哪一屏（曾经整场静默挂死）
      if (i % 2 === 1) console.log(`    · 滚动审计 第 ${i + 1} 步（页 ${moved.before}→${moved.after}），已覆盖 ${visited.size} 页，异常 ${problems.size} 页`);
    }
    return { visited: [...visited].sort((a, b) => a - b), problems: [...problems.values()], firstBadSnapshot };
  }

  async function openLong(name, expectPages) {
    await cdp.eval(`
      const buf = await (await fetch('/tests/fixtures/${name}')).arrayBuffer();
      await window.__caj.openFile(new File([buf], '${name}'));
      return 1;
    `);
    await cdp.waitFor(`window.__caj.state.numPages === ${expectPages}`, { label: `打开 ${name}` });
    await cdp.waitFor("document.querySelector('.page canvas')", { label: `${name} 首屏渲染` });
    await sleep(600);
  }

  /* F1：24 页 CAJ，适应宽度，像正常阅读那样向下滚 */
  await openLong('sample-long.caj', 24);
  const cajThrough = await scrollThrough();
  check('长 CAJ 从头滚到尾：滚过的每一页都画出了内容并带文本层',
    cajThrough.problems.length === 0,
    `滚过 ${cajThrough.visited.length}/24 页，异常 ${cajThrough.problems.length} 页 `
    + `${JSON.stringify(cajThrough.problems.slice(0, 6))}`);
  check('长 CAJ 滚动覆盖到最后一页', cajThrough.visited.at(-1) === 24, `最远到第 ${cajThrough.visited.at(-1)} 页`);
  if (cajThrough.firstBadSnapshot) {
    console.log('  · 首个异常页现场：', JSON.stringify(cajThrough.firstBadSnapshot));
  }
  await cdp.screenshot(join(OUT, '11-long-caj-mid.png'));

  /* F2：缩小到一屏能看到十几页 —— 这会触发页面回收，是最容易出现空白的场景 */
  await cdp.eval("window.__caj.zoomTo(0.25); return 1;");
  await sleep(800);
  const zoomedOut = await scrollThrough();
  check('缩小到 19% 后滚动：被回收的页面回到视野时必须重新渲染',
    zoomedOut.problems.length === 0,
    `滚过 ${zoomedOut.visited.length} 页，异常 ${zoomedOut.problems.length} 页 `
    + `${JSON.stringify(zoomedOut.problems.slice(0, 6))}`);
  await cdp.screenshot(join(OUT, '12-long-caj-zoomout.png'));

  /* F3：60 页 PDF，适应宽度整本滚一遍 */
  await cdp.eval("window.__caj.setFit('width'); return 1;");
  await openLong('sample-long.pdf', 60);
  const pdfThrough = await scrollThrough();
  check('60 页 PDF 从头滚到尾：无空白页、无丢失文本层',
    pdfThrough.problems.length === 0,
    `滚过 ${pdfThrough.visited.length}/60 页，异常 ${pdfThrough.problems.length} 页 `
    + `${JSON.stringify(pdfThrough.problems.slice(0, 6))}`);
  check('60 页 PDF 滚动覆盖到最后一页', pdfThrough.visited.at(-1) === 60, `最远到第 ${pdfThrough.visited.at(-1)} 页`);

  /* F4：滚回顶部 —— 被回收过的第 1 页必须重新出现 */
  const backTop = await (async () => {
    await cdp.eval("document.querySelector('#viewer').scrollTop = 0; return 1;");
    const deadline = Date.now() + 6000;
    for (;;) {
      const rows = await cdp.eval(AUDIT);
      const first = rows.find((r) => r.num === 1);
      if (first && first.hasCanvas && first.colors > 3) return first;
      if (Date.now() > deadline) return first ?? null;
      await sleep(150);
    }
  })();
  check('滚回顶部后第 1 页重新渲染出来',
    !!backTop && backTop.hasCanvas && backTop.colors > 3,
    JSON.stringify(backTop));

  /* ── 场景 G：托管把 .wasm 发成错误 MIME 时必须仍能工作 ── */
  console.log('\n— 场景 G：.wasm MIME 不正确时的兜底 —');

  // 在页面脚本执行之前替换 compileStreaming，模拟「服务器没把 .wasm 标成 application/wasm」
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `WebAssembly.compileStreaming = () => Promise.reject(
      new TypeError('simulated: Response has unsupported MIME type'));`,
  });
  await cdp.eval("window.__caj.setFit('width'); return 1;");
  await reload();

  const mimeForced = await cdp.eval(`
    try {
      await WebAssembly.compileStreaming(new Response(new Uint8Array([0, 97, 115, 109])));
      return 'not-forced';
    } catch (e) { return e.message; }
  `);
  check('已成功模拟「.wasm MIME 不正确」的托管环境',
    mimeForced.includes('simulated'), mimeForced);

  await cdp.eval(`
    const buf = await (await fetch('/tests/fixtures/sample.caj')).arrayBuffer();
    await window.__caj.openFile(new File([buf], 'sample.caj'));
    return 1;
  `);
  let mimeOk = true;
  try {
    await cdp.waitFor('window.__caj.state.numPages === 2', {
      label: 'MIME 异常时仍能转换 CAJ', timeout: 25000,
    });
  } catch { mimeOk = false; }

  await cdp.eval("document.querySelector('#toast').hidden = true; return 1;");
  check('服务器 .wasm MIME 配错时，引擎退回一次性编译并照常工作',
    mimeOk && await cdp.eval("return document.querySelector('#formatBadge').textContent === 'CAJ';"),
    mimeOk ? '已回退到 WebAssembly.compile' : '回退失败，页面无内容');

  /* 13. 控制台干净 */
  const ignorable = (t) => /favicon|Failed to load resource/i.test(t);
  const badConsole = consoleErrors.filter((t) => !ignorable(t));
  const badPage = pageErrors.filter((t) => !ignorable(t));
  check('无未捕获的页面异常', badPage.length === 0, badPage.slice(0, 3).join(' | '));
  check('控制台无错误', badConsole.length === 0, badConsole.slice(0, 3).join(' | '));

  /* ── 场景 H：脚本被拦掉时，页面必须自己把原因说出来 ──
     这是「iPad 上只显示主界面、点什么都没反应」最可能的成因，
     也是唯一一种用户完全无法自行排查的失败。故意拦截 app.js 来验证看门狗。 */
  console.log('\n— 场景 H：脚本加载失败时的自诊断 —');
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*app/app.js*'] });

  const loadedAgain = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.reload', { ignoreCache: true });
  await loadedAgain;
  await sleep(4200);   // 看门狗在 3 秒时触发

  const watchdog = await cdp.eval(`
    const panel = document.querySelector('#caj-diag');
    return {
      shown: !!panel,
      text: panel ? panel.textContent : '',
      cajLoaded: !!window.__cajLoaded,
      appAlive: !!window.__caj,
      emptyVisible: !document.querySelector('#empty').hidden,
    };
  `);
  check('脚本被拦掉时，页面弹出诊断面板（而不是静默无反应）',
    watchdog.shown && !watchdog.appAlive && !watchdog.cajLoaded && watchdog.emptyVisible,
    JSON.stringify({ shown: watchdog.shown, cajLoaded: watchdog.cajLoaded, appAlive: watchdog.appAlive }));
  check('诊断面板指明「脚本未加载」并给出可执行的下一步',
    watchdog.text.includes('应用没能启动') && watchdog.text.includes('脚本未加载')
    && watchdog.text.includes('app/'),
    watchdog.text.slice(0, 160).replace(/\s+/g, ' '));
  await cdp.screenshot(join(OUT, '14-boot-diagnostic.png'));

  await cdp.send('Network.setBlockedURLs', { urls: [] });

  /* ── 场景 I：托管开了访问保护（401）时，必须精确指出原因 ──
     Netlify / Cloudflare 的密码保护会把整站拦住，脚本请求也返回一张 HTML 密码页；
     浏览器只对页面本身放行，于是表现成「界面在、脚本没跑」。用 CDP 伪造这个响应。 */
  console.log('\n— 场景 I：访问保护（401）时的诊断 —');
  const GUARD_BODY = '<html><head><title>Password Protection</title></head>'
    + '<body>Password Protection</body></html>';

  // 共用一个拦截器：命中 mock.rule 的请求按 mock 返回，其余原样放行。
  const mock = { rule: null, status: 0, type: 'text/html', body: '' };
  cdp.on('Fetch.requestPaused', async (p) => {
    const url = p.request.url;
    try {
      if (!mock.rule || !mock.rule.test(url)) {
        await cdp.send('Fetch.continueRequest', { requestId: p.requestId });
        return;
      }
      await cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: mock.status,
        responseHeaders: [
          { name: 'Content-Type', value: mock.type },
          { name: 'Content-Length', value: String(Buffer.byteLength(mock.body)) },
        ],
        body: Buffer.from(mock.body).toString('base64'),
      });
    } catch { /* 通道可能已关闭 */ }
  });

  mock.rule = /app\/app\.js/;
  mock.status = 401;
  mock.type = 'text/html';
  mock.body = GUARD_BODY;
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*app/app.js*', requestStage: 'Request' }],
  });

  const loadedProtected = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.reload', { ignoreCache: true });
  await loadedProtected;
  await sleep(4500);   // 看门狗 3 秒触发，再加一次探测往返

  const guarded = await cdp.eval(`
    const panel = document.querySelector('#caj-diag');
    const rows = panel ? [...panel.querySelectorAll('td')].map((td) => td.textContent) : [];
    return { shown: !!panel, text: panel ? panel.textContent : '', rows };
  `);
  check('托管返回 401 时，诊断面板指出「被访问保护拦截」',
    guarded.shown && guarded.rows.some((r) => r.includes('HTTP 401'))
    && guarded.text.includes('访问保护'),
    guarded.text.slice(0, 220).replace(/\s+/g, ' '));
  check('诊断面板给出了关掉密码保护的具体路径',
    guarded.text.includes('Password protection') && guarded.text.includes('Netlify'),
    '');
  await cdp.screenshot(join(OUT, '15-protected-host.png'));

  await cdp.send('Fetch.disable');

  /* ── 场景 J：入口正常、但某个依赖加载失败 ──
     这是最容易被误诊的一类：浏览器报的是**入口文件**的名字
     （"Failed to fetch dynamically imported module: .../app/app.js"），
     真正出问题的却是它 import 的某个文件。
     这也正是线上真实踩过的坑（托管商没把 .mjs 当 JavaScript 下发）。
     这里用一个 404 的依赖复现同样的形态，验证诊断能指名道姓。 */
  console.log('\n— 场景 J：模块依赖加载失败时的诊断 —');
  mock.rule = /pdfjs\/build\/pdf\.min\.js/;
  mock.status = 404;
  mock.type = 'text/html';
  mock.body = '<html><body>404 Not Found</body></html>';
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*pdf.min.js*', requestStage: 'Request' }],
  });

  const loadedDepFail = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.reload', { ignoreCache: true });
  await loadedDepFail;
  await sleep(6000);   // 看门狗 + 依赖链探测需要几轮往返

  const depFail = await cdp.eval(`
    const panel = document.querySelector('#caj-diag');
    return { shown: !!panel, text: panel ? panel.textContent : '' };
  `);
  check('依赖加载失败时，诊断面板指出是「依赖」而不是入口',
    depFail.shown && depFail.text.includes('pdf.min.js')
    && depFail.text.includes('HTTP 404'),
    depFail.text.slice(0, 260).replace(/\s+/g, ' '));
  check('诊断面板给出了「依赖 MIME / 404」的处置建议',
    depFail.text.includes('严格 MIME 检查') || depFail.text.includes('上传时漏了这个文件'),
    '');
  await cdp.screenshot(join(OUT, '16-dependency-failure.png'));

  await cdp.send('Fetch.disable');
  mock.rule = null;

  /* ═════════════ 2.0：双指缩放 / 设置面板 / 多文档标签 ═════════════ */

  // 必须刷新一次：上面两个场景是「故意把依赖打成 401 / 404」再加载页面的，
  // 当前这份文档的模块图本来就是坏的（window.__caj 都没建起来）。
  {
    const fresh = new Promise((res) => cdp.on('Page.loadEventFired', res));
    await cdp.send('Page.reload', { ignoreCache: true });
    await fresh;
  }
  await cdp.waitFor('typeof window.__caj !== "undefined" && !!window.__caj.pinch',
    { label: '2.0 接口就绪', timeout: 60000 });

  /* ── 场景 K：双指缩放不再靠 transform + scroll 心算 ── */
  console.log('\n— 场景 K：双指缩放（笔记 App 手势）—');
  const pinchMath = await cdp.eval(`
    const m = await import('/app/pinch-math.js');
    const out = { mod: typeof m.previewRatio === 'function', status: 0, size: 0, err: null, numPages: 0, list: [] };
    const res = await fetch('/tests/fixtures/sample-long.caj');
    out.status = res.status;
    const buf = await res.arrayBuffer();
    out.size = buf.byteLength;
    try {
      await window.__caj.openFile(new File([buf], 'long.caj'));
    } catch (e) { out.err = e.name + ': ' + e.message; }
    await new Promise((r) => setTimeout(r, 400));
    out.numPages = window.__caj.state.numPages;
    out.list = window.__caj.docs.list().map((d) => d.fileName + ':' + d.numPages + (d.active ? '*' : ''));
    return out;
  `);
  check('场景 K：夹具可读取且长 CAJ 转换成功',
    pinchMath.status === 200 && pinchMath.size === 31935 && !pinchMath.err && pinchMath.numPages === 24,
    `HTTP ${pinchMath.status} ${pinchMath.size}B err=${pinchMath.err} pages=${pinchMath.numPages} docs=[${pinchMath.list.join(', ')}]`);
  const pinchReady = !pinchMath.err && pinchMath.numPages === 24;
  if (pinchReady) await cdp.waitFor('window.__caj.state.numPages === 24', { label: '长 CAJ 打开', timeout: 60000 });
  await cdp.eval('window.__caj.scrollToPage(10); return 1;');
  await sleep(700);

  const pinchResult = pinchReady ? await cdp.eval(`
    const viewer = document.querySelector('#viewer');
    // 注意：#pages 可能同时存在多个（后台标签各自持有一个容器），
    // 必须取「应用当前正在渲染」的那一个，否则量到的永远是空 transform。
    // window.__caj.pagesEl 就是 app.js 里那个模块级引用。
    const pages = window.__caj.pagesEl;
    const rect = viewer.getBoundingClientRect();
    const before = { scrollTop: viewer.scrollTop, scale: window.__caj.state.pages[window.__caj.state.current - 1].scale };
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const touchId = 1;

    // 注意：Touch 的 clientX/clientY 是只读的，每次 touched 必须新建 Touch 对象。
    function touch(x, y, id) {
      return new Touch({ identifier: id, target: pages, clientX: x, clientY: y, pageX: x, pageY: y });
    }
    function fire(node, type, list) {
      return node.dispatchEvent(new TouchEvent(type, {
        touches: list, targetTouches: list, changedTouches: list,
        bubbles: true, cancelable: true,
      }));
    }

    const labelBefore = document.querySelector('#btnZoomLevel').textContent;
    fire(pages, 'touchstart', [touch(cx - 60, cy, touchId), touch(cx + 60, cy, touchId + 1)]);
    const startedActive = window.__caj.pinch.isActive();
    const overflowDuring = viewer.style.overflow;

    let maxJump = 0;
    const transforms = [];
    for (let i = 1; i <= 6; i++) {
      const half = 60 + i * 10;
      fire(pages, 'touchmove', [touch(cx - half, cy, touchId), touch(cx + half, cy, touchId + 1)]);
      maxJump = Math.max(maxJump, Math.abs(viewer.scrollTop - before.scrollTop));
      transforms.push(pages.style.transform);
    }
    const duringActive = window.__caj.pinch.isActive();
    const transformDuringGesture = pages.style.transform;
    const labelDuring = document.querySelector('#btnZoomLevel').textContent;
    const scrollTopDuring = viewer.scrollTop;

    fire(pages, 'touchend', []);
    const after = {
      scrollTop: viewer.scrollTop,
      scale: window.__caj.state.pages[window.__caj.state.current - 1].scale,
      transform: pages.style.transform,
      active: window.__caj.pinch.isActive(),
      overflow: viewer.style.overflow,
      label: document.querySelector('#btnZoomLevel').textContent,
    };
    return { before, startedActive, overflowDuring, duringActive, transformDuringGesture, transforms, labelBefore, labelDuring, scrollTopDuring, maxJump, after, pagesCount: document.querySelectorAll('#pages').length, connected: pages.isConnected };
  `) : { before: { scrollTop: 0, scale: 0 }, duringActive: false, transformDuringGesture: '', maxJump: -1, after: { active: true, transform: 'x', scale: 0, scrollTop: 0, label: '' } };

  const pinchPreviewOk = (pinchResult.transforms || []).some((t) => /scale\(/.test(t));
  check('双指缩放：手势进行中冻结滚动并只靠 #pages 的 transform 预览',
    pinchResult.startedActive === true
    && pinchResult.duringActive === true
    && pinchResult.maxJump === 0
    && pinchPreviewOk
    && (pinchResult.transforms || []).slice(-1)[0] === pinchResult.transformDuringGesture,
    `active=${pinchResult.duringActive} maxJump=${pinchResult.maxJump} 预览帧=${JSON.stringify(pinchResult.transforms || []).slice(0, 200)}`);
  check('双指缩放：抬手前实时放大（标签跟随），抬起后清掉预览 transform 并按同一比例落地',
    pinchResult.after.active === false
    && pinchResult.after.transform === ''
    && pinchResult.labelDuring !== pinchResult.labelBefore
    && pinchResult.after.scale > pinchResult.before.scale
    && pinchResult.after.scale <= 8,
    `scale ${pinchResult.before.scale.toFixed(3)} → ${pinchResult.after.scale.toFixed(3)}，标签 ${pinchResult.labelBefore} →（手势中 ${pinchResult.labelDuring}）→ ${pinchResult.after.label}`);
  check('双指缩放：焦点不变式成立（滚动位置按比例跟随，不会剧烈乱跳）',
    pinchResult.after.scrollTop >= 0
    && Math.abs(pinchResult.after.scrollTop - pinchResult.before.scrollTop * (pinchResult.after.scale / pinchResult.before.scale || 1)) <= pinchResult.before.scrollTop * 0.6 + 200,
    `scrollTop ${pinchResult.before.scrollTop} → ${pinchResult.after.scrollTop}（手势中 ${pinchResult.scrollTopDuring}）`);
  check('双指缩放数学模块可独立加载并导出纯函数',
    pinchMath.mod === true, `typeof previewRatio=${typeof pinchMath.mod}`);
  await cdp.screenshot(join(OUT, '17-pinch-zoom.png'));

  /* ── 场景 L：设置面板 ── */
  console.log('\n— 场景 L：设置与自诊断面板 —');
  const settingsPanel = await cdp.eval(`
    const gear = document.querySelector('#btnSettings');
    gear.click();
    await new Promise((r) => setTimeout(r, 250));
    const overlay = document.querySelector('#settingsOverlay');
    const tabs = [...document.querySelectorAll('#settingsTabs .settings-tab')].map((b) => b.dataset.setTab);
    const settings = window.__caj.settings;
    // 用公开 API 切分区：点击 tab 是真实路径，但断言只关心分区内容是否渲染
    settings.open('diagnostics');
    await new Promise((r) => setTimeout(r, 2500));
    const activeText = () => {
      const body = document.querySelector('#settingsBody');
      if (!body) return '';
      const active = [...body.querySelectorAll('.settings-section')].filter((s) => !s.hidden);
      return active.map((s) => s.textContent).join(' ').replace(/\\s+/g, ' ').trim();
    };
    const diagText = activeText();
    settings.open('about');
    await new Promise((r) => setTimeout(r, 300));
    const aboutText = activeText();
    return {
      overlayHidden: overlay.hidden,
      panelPresent: !!document.querySelector('#settingsPanel'),
      tabs,
      gearOpened: settings.isOpen(),
      diagText: diagText.slice(0, 320),
      aboutText: aboutText.slice(0, 320),
      versionApp: window.__caj.app.version && window.__caj.app.version.app,
      versionCommit: window.__caj.app.version && window.__caj.app.version.commit,
      updateButton: !!document.querySelector('#setUpdateCheck'),
      versionInDom: ((document.querySelector('#setVersionApp') || {}).textContent || '').trim(),
    };
  `);
  check('工具栏齿轮能打开设置面板',
    settingsPanel.overlayHidden === false && settingsPanel.panelPresent === true,
    `hidden=${settingsPanel.overlayHidden} panel=${settingsPanel.panelPresent}`);
  check('设置面板分为外观 / 阅读 / 文件 / 诊断 / 关于五个分区',
    ['appearance', 'reading', 'files', 'diagnostics', 'about']
      .every((id) => settingsPanel.tabs.includes(id)),
    settingsPanel.tabs.join(','));
  check('设置面板的诊断分区内联显示自检结果（不必另开弹窗）',
    settingsPanel.diagText.includes('caj2pdf_wasm.wasm') && settingsPanel.diagText.includes('离线缓存'),
    settingsPanel.diagText.slice(0, 200));
  check('设置面板的「关于」显示应用版本号',
    settingsPanel.versionApp === '2.0.0' && /2\.0\.0/.test(settingsPanel.aboutText),
    `version=${settingsPanel.versionApp} about=${settingsPanel.aboutText.slice(0, 80)}`);
  await cdp.screenshot(join(OUT, '18-settings-panel.png'));

  const closed = await cdp.eval(`
    document.querySelector('#settingsClose').click();
    await new Promise((r) => setTimeout(r, 200));
    return document.querySelector('#settingsOverlay').hidden;
  `);
  check('设置面板可以关闭', closed === true, `hidden=${closed}`);

  /* ── 场景 M：多文档标签切换 ── */
  console.log('\n— 场景 M：多文档标签切换 —');
  const tabsState = await cdp.eval(`
    const before = window.__caj.docs.list();
    const pdfBuf = await (await fetch('/tests/fixtures/sample-long.pdf')).arrayBuffer();
    await window.__caj.openFile(new File([pdfBuf], 'long.pdf', { type: 'application/pdf' }));
    await new Promise((r) => setTimeout(r, 600));
    const afterOpen = window.__caj.docs.list();
    const tabButtons = [...document.querySelectorAll('#docTabList .doc-tab')].map((b) => b.textContent.trim());
    return {
      before: before.map((d) => d.fileName),
      afterOpen: afterOpen.map((d) => ({ fileName: d.fileName, active: d.active })),
      tabButtons,
      activePages: window.__caj.state.numPages,
    };
  `);
  check('打开第二个文件会新增标签而不是顶替上一个',
    tabsState.afterOpen.length >= 2
    && tabsState.afterOpen.filter((d) => d.active).length === 1
    && tabsState.tabButtons.length >= 2,
    JSON.stringify(tabsState.afterOpen));

  const switched = await cdp.eval(`
    const list = window.__caj.docs.list();
    const prev = list.find((d) => !d.active);
    const ok = await window.__caj.docs.switchTo(prev.id);
    await new Promise((r) => setTimeout(r, 500));
    return {
      ok,
      active: window.__caj.docs.list().find((d) => d.active),
      numPages: window.__caj.state.numPages,
      fileName: window.__caj.state.fileName,
      pageDomCount: document.querySelectorAll('.page').length,
      viewerHasPages: !!document.querySelector('#viewer #pages'),
    };
  `);
  check('能在已打开的文件之间切换，且切换后文档完整可用',
    switched.ok === true
    && switched.active
    && switched.numPages > 0
    && switched.pageDomCount > 0
    && switched.viewerHasPages === true,
    `${switched.fileName} / ${switched.numPages} 页 / ${switched.pageDomCount} 个页面容器`);
  await cdp.screenshot(join(OUT, '19-multi-tab.png'));

  const closedTab = await cdp.eval(`
    const before = window.__caj.docs.list().length;
    window.__caj.docs.closeActive();
    await new Promise((r) => setTimeout(r, 500));
    return {
      before,
      after: window.__caj.docs.list().length,
      activeNull: window.__caj.docs.activeId() === null || window.__caj.docs.list().some((d) => d.active),
      numPages: window.__caj.state.numPages,
    };
  `);
  check('关闭当前标签后剩下一个仍然可读（不会停在空白页）',
    closedTab.after === closedTab.before - 1 && closedTab.numPages > 0,
    `${closedTab.before} → ${closedTab.after}，剩余 ${closedTab.numPages} 页`);

  /* ── 场景 N：单页 / 连续滚动与页面间距 ── */
  console.log('\n— 场景 N：阅读设置真的生效 —');
  const readingPrefs = await cdp.eval(`
    // 间距只影响「页与页之间」，所以必须用多页文档量；单页文档首末页用的是 pad。
    const res0 = await fetch('/tests/fixtures/sample.caj');
    const buf0 = await res0.arrayBuffer();
    await window.__caj.openFile(new File([buf0], 'gap.caj'));
    await new Promise((r) => setTimeout(r, 900));
    const before = window.__caj.pagesEl.querySelectorAll('.page').length;
    document.querySelector('#btnSettings').click();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector('#settingsTabs .settings-tab[data-set-tab="reading"]').click();
    document.querySelector('#setScrollSeg .settings-seg-btn[data-value="single"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const single = {
      className: document.querySelector('#viewer').className,
      visiblePages: [...window.__caj.pagesEl.querySelectorAll('.page')].filter((p) => p.offsetParent !== null).length,
    };
    document.querySelector('#setScrollSeg .settings-seg-btn[data-value="continuous"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const gapSel = document.querySelector('#setPageGap');
    gapSel.value = '28';
    gapSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const pages = [...window.__caj.pagesEl.querySelectorAll('.page')];
    const allMargins = pages.slice(0, 4).map((p) => p.style.marginTop);
    const afterGap = allMargins[1] || '';
    const prefsNow = window.__caj.settings.getPrefs();
    const gapVar = getComputedStyle(document.documentElement).getPropertyValue('--page-gap').trim();
    document.querySelector('#settingsClose').click();
    return { before, single, afterGap, allMargins, gapVar, prefsNow, pageCount: pages.length, strayPages: document.querySelectorAll('#pages').length };
  `);
  check('「单页」模式只显示当前一页',
    /single-page/.test(readingPrefs.single.className) && readingPrefs.single.visiblePages === 1,
    `class=${readingPrefs.single.className} visible=${readingPrefs.single.visiblePages}`);
  check('「页面间距」设置被布局真正消费',
    readingPrefs.afterGap === '28px',
    `margins=${JSON.stringify(readingPrefs.allMargins)} prefs=${JSON.stringify(readingPrefs.prefsNow)} pages=${readingPrefs.pageCount} 残留容器=${readingPrefs.strayPages}`);
  check('不该在 #viewer 里留下孤立的页面容器',
    readingPrefs.strayPages === 1, `#pages 元素数=${readingPrefs.strayPages}`);
  await cdp.screenshot(join(OUT, '20-reading-prefs.png'));

  /* ── 场景 O：版本与更新产物 ── */
  console.log('\n— 场景 O：版本号与更新流程产物 —');
  const versionInfo = await cdp.eval(`
    const v = await import('/app/version.js');
    let manifest = null;
    try { manifest = await (await fetch('/version.json')).json(); } catch { manifest = null; }
    const updateRes = await fetch('/IPAD-UPDATE.md');
    const updateText = updateRes.ok ? (await updateRes.text()).slice(0, 80) : '';
    return {
      app: v.VERSION.app,
      commit: v.VERSION.commit,
      channel: v.VERSION.channel,
      manifestApp: manifest && manifest.app,
      manifestCommit: manifest && manifest.commit,
      manifestFiles: manifest && Array.isArray(manifest.files) ? manifest.files.length : 0,
      updateStatus: updateRes.status,
      updateType: updateRes.headers.get('content-type'),
      updateText,
    };
  `);
  check('版本号由 VERSION 文件注入且构建可复现',
    versionInfo.app === '2.0.0' && typeof versionInfo.commit === 'string',
    `${versionInfo.app} / ${versionInfo.commit} / ${versionInfo.channel}`);
  check('更新用的 version.json 可在站点根取到（含版本、提交与文件清单）',
    versionInfo.manifestApp === '2.0.0' && versionInfo.manifestFiles > 0,
    `app=${versionInfo.manifestApp} files=${versionInfo.manifestFiles}`);
  check('随包附带的原地更新说明可访问且按文本下发（不是下载流）',
    versionInfo.updateStatus === 200 && /text\/markdown|text\/plain/.test(String(versionInfo.updateType || '')),
    `HTTP ${versionInfo.updateStatus} type=${versionInfo.updateType}`);

} catch (err) {
  check('测试流程本身未抛异常', false, err.message);
  console.error('\n' + (err.stack || err.message));

  // 出错时把浏览器侧的诊断信息全部倒出来，方便定位
  console.error('\n— 浏览器控制台错误 —');
  console.error(consoleErrors.length ? consoleErrors.map((t) => `  · ${t}`).join('\n') : '  （无）');
  console.error('— 浏览器控制台全部输出 —');
  console.error(allConsole.length ? allConsole.map((t) => `  · ${t}`).join('\n') : '  （无）');
  console.error('— 未捕获异常 —');
  console.error(pageErrors.length ? pageErrors.map((t) => `  · ${t}`).join('\n') : '  （无）');

  try {
    const diag = await cdp.eval(`
      return {
        href: location.href,
        hasCaj: typeof window.__caj,
        resources: performance.getEntriesByType('resource').map(r => r.name.replace(location.origin, '')).slice(0, 40),
        emptyText: document.querySelector('#empty')?.textContent?.trim().slice(0, 60),
      };
    `);
    console.error('— 页面诊断 —');
    console.error(JSON.stringify(diag, null, 2));
  } catch (e2) {
    console.error('  诊断取值失败：', e2.message);
  }
} finally {
  try { cdp?.ws.close(); } catch { /* 忽略 */ }
  try { chrome?.kill(); } catch { /* 忽略 */ }
  try { server?.kill(); } catch { /* 忽略 */ }
  await sleep(400);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

/* ─────────────────────────  汇总  ───────────────────────── */

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${'─'.repeat(60)}`);
console.log(`检查项：${results.length}   通过：${passed}   失败：${failed}`);
console.log(`截图目录：${OUT}`);
if (failed) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name} — ${r.detail}`);
}
const warnings = allConsole.filter((t) => /warning|warn/i.test(t));
if (warnings.length) {
  console.log('\n浏览器警告（供参考）：');
  for (const w of warnings.slice(0, 12)) console.log(`  · ${w}`);
}
console.log(`${failed ? 'FAIL' : 'PASS'}\n`);
process.exit(failed ? 1 : 0);
