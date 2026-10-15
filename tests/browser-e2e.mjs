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
        if (msg.error) p.reject(new Error(`${msg.error.message} (${p.method})`));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve_, reject) => {
      this.pending.set(id, { resolve: resolve_, reject, method });
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
  check('页数为 2', cajView.numPages === 2 && cajView.pageCountText === '2');
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
  check('iPad 视口下页数正确', ipad.pageCount === '2');
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
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4 * 211) {
          seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
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

    for (let i = 0; i < maxSteps; i++) {
      for (const row of await auditVisible()) {
        visited.add(row.num);
        const bad = !row.hasCanvas || row.colors <= 3 || row.spans === 0;
        if (bad && !problems.has(row.num)) {
          problems.set(row.num, row);
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
