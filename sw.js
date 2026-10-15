/* ==========================================================================
 * CAJ 阅读器 — Service Worker
 *
 * 目的：让应用可以「安装到主屏」并在断网后继续打开。
 * 策略：
 *   · 应用外壳（HTML/CSS/JS/manifest）→ stale-while-revalidate，启动最快
 *   · vendor 资源（WASM / PDF.js / 字体表）→ cache-first，体积大且几乎不变
 *   · 其余子资源（脚本 / 样式 / Worker / 字体 / 图片…）→ network-first，
 *     失败时回退缓存；但绝不把 HTML 兜底页当成脚本 / 样式下发
 *   · 其余请求 → 直连网络，绝不缓存（避免把用户文档写进缓存）
 *
 * 离线预热：页面通过 postMessage({ type: 'cache-vendor' }) 主动触发，
 * 把体积大的运行时资源一次性拉进 VENDOR 缓存。绝不放在 install 里，
 * 否则首屏安装会被几十 MB 的下载拖死。
 *
 * 注意：Service Worker 只在安全上下文（https 或 localhost）注册。
 * 通过局域网 http://192.168.x.x 访问 iPad 时不会注册，但应用照常可用。
 * ========================================================================== */

const VERSION = 'caj-viewer-v1';
const SHELL = `${VERSION}-shell`;
const VENDOR = `${VERSION}-vendor`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app/app.js',
  './app/compat.js',
  './app/style.css',
  './app/icon.svg',
];

/**
 * 离线预热的默认清单（相对站点根）。
 * 这些是「断网后第一次打开」真正会用到的东西：外壳 + 引擎 + 字体表 + PDF.js。
 * 消息里带 urls 时以消息内容为准。
 */
const VENDOR_FILES = [
  './index.html',
  './app/app.js',
  './app/style.css',
  './manifest.webmanifest',
  './app/icon.svg',
  './app/icon-180.png',
  './app/icon-192.png',
  './app/icon-512.png',
  './vendor/pdfjs/build/pdf.min.js',
  './vendor/pdfjs/build/pdf.worker.min.js',
  './vendor/pdfjs/pdf_viewer.css',
  './vendor/caj2pdf-rust/browser.js',
  './vendor/caj2pdf-rust/caj2pdf_wasm.wasm',
  './vendor/caj2pdf-rust/caj2pdf-fonts-v1.bin',
  './vendor/caj2pdf-rust/internal/worker.js',
  './vendor/caj2pdf-rust/internal/run.js',
  // 引擎的 ES 模块依赖闭包：app.js → browser.js → io.js / internal/run.js，
  // 以及模块 Worker internal/worker.js → bundled-fonts.js → font-pack.js。
  // 少任何一个，断网后第一次打开都会在 import 阶段直接失败。
  './vendor/caj2pdf-rust/io.js',
  './vendor/caj2pdf-rust/internal/bundled-fonts.js',
  './vendor/caj2pdf-rust/internal/font-pack.js',
  // Node 侧才用到的分片写入实现，浏览器路径不会加载它。
  './vendor/caj2pdf-rust/internal/spool-write.js',
  // PDF.js 的解码器是按需拉取的：扫描件的 JBIG2 / JPEG2000、颜色管理（QCMS）、
  // 以及标准字体与 CJK 字符映射表。缺了它们，断网后第一次打开会静默降级
  // ——扫描页空白、中文乱码——所以一起预热，总体积不到 3 MB。
  './vendor/pdfjs/wasm/jbig2.wasm',
  './vendor/pdfjs/wasm/openjpeg.wasm',
  './vendor/pdfjs/wasm/qcms_bg.wasm',
  './vendor/pdfjs/wasm/quickjs-eval.wasm',
  './vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  './vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
  './vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
  './vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
  './vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
  './vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb',
  './vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb',
  './vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSerif.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSymbol.pfb',
  './vendor/pdfjs/standard_fonts/FoxitDingbats.pfb',
  './vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UCS2-V.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF16-H.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF16-V.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF8-H.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF8-V.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF32-H.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF32-V.bcmap',
  './vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
  './vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap',
  './vendor/pdfjs/cmaps/UniJIS-UCS2-V.bcmap',
  './vendor/pdfjs/cmaps/UniJIS-UTF16-H.bcmap',
  './vendor/pdfjs/cmaps/UniJIS-UTF16-V.bcmap',
  './vendor/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap',
  './vendor/pdfjs/cmaps/UniKS-UCS2-H.bcmap',
  './vendor/pdfjs/cmaps/UniKS-UCS2-V.bcmap',
  './vendor/pdfjs/cmaps/UniKS-UTF16-H.bcmap',
  './vendor/pdfjs/cmaps/UniKS-UTF16-V.bcmap',
  './vendor/pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap',
  './vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap',
  './vendor/pdfjs/cmaps/UniCNS-UCS2-V.bcmap',
  './vendor/pdfjs/cmaps/UniCNS-UTF16-H.bcmap',
  './vendor/pdfjs/cmaps/UniCNS-UTF16-V.bcmap',
  './vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap',
];

/** 同时下载的文件数。太大在 iPad 上会挤爆内存，太小又慢。 */
const MAX_CONCURRENT = 3;

/** 这些后缀的资源一旦被 HTML「兜底」，浏览器会报 MIME 错，必须拦住。 */
const SUBRESOURCE_EXT = /\.(js|mjs|css|wasm|bin|json|bcmap)$/i;
/** request.destination 命中这些说明它是子资源而不是文档本身。 */
const SUBRESOURCE_DEST = new Set([
  'script', 'style', 'worker', 'sharedworker', 'serviceworker',
  'font', 'image', 'audio', 'video', 'manifest', 'track', 'embed', 'object',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

/* ─────────────────────────  离线预热  ───────────────────────── */

/** 把相对路径拼成绝对 URL（fetch 与 cache key 都用它）。 */
function absoluteUrl(input) {
  try {
    return new URL(input, self.location).href;
  } catch {
    return null;
  }
}

/** 容错地把进度/结果回给触发消息的那个页面（source 可能为空）。 */
function postToSource(source, message) {
  if (!source || typeof source.postMessage !== 'function') return;
  try {
    source.postMessage(message);
  } catch { /* 页面可能已经关掉了 */ }
}

/**
 * 逐个抓取并写入 VENDOR 缓存。
 * 单个文件失败只记录、不中断；完成后返回 { ok, failed, bytes }。
 */
async function cacheVendorFiles(urls, source) {
  const cache = await caches.open(VENDOR);
  const total = urls.length;
  const failed = [];
  let bytes = 0;
  let done = 0;
  let cursor = 0;

  const reportProgress = (url) => {
    done += 1;
    postToSource(source, { type: 'cache-vendor-progress', done, total, url });
  };

  const worker = async () => {
    while (cursor < total) {
      const entry = urls[cursor++];
      const abs = absoluteUrl(entry);
      if (!abs) {
        failed.push(entry);
        reportProgress(entry);
        continue;
      }
      try {
        const res = await fetch(abs, { cache: 'reload' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 服务器把「文件不存在」兜底成 200 + index.html 时，res.ok 也是 true。
        // 只有后缀一定会被当成子资源解析的文件才拒绝，index.html 本身要正常缓存。
        if (isHtmlResponse(res) && SUBRESOURCE_EXT.test(new URL(abs).pathname)) {
          throw new Error('HTML fallback');
        }
        const buf = await res.arrayBuffer();
        // 不复用原响应的 content-encoding / content-length：fetch 已经解压过，
        // 直接透传这些头会让缓存的响应在下次读取时被二次解码。
        const headers = new Headers();
        res.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower === 'content-encoding' || lower === 'content-length') return;
          headers.set(key, value);
        });
        await cache.put(abs, new Response(buf, {
          status: res.status,
          statusText: res.statusText,
          headers,
        }));
        bytes += buf.byteLength;
      } catch {
        failed.push(entry);
      } finally {
        reportProgress(entry);
      }
    }
  };

  const lanes = Math.min(MAX_CONCURRENT, Math.max(total, 1));
  await Promise.all(Array.from({ length: lanes }, worker));
  return { ok: failed.length === 0, failed, bytes, total };
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'cache-vendor') return;

  const urls = Array.isArray(data.urls) && data.urls.length ? data.urls : VENDOR_FILES;
  const source = event.source || null;

  const task = (async () => {
    let result;
    try {
      result = await cacheVendorFiles(urls, source);
    } catch (err) {
      result = { ok: false, failed: urls.slice(), bytes: 0, total: urls.length, error: String(err) };
    }
    postToSource(source, {
      type: 'cache-vendor-done',
      ok: result.ok,
      failed: result.failed,
      bytes: result.bytes,
      total: result.total,
    });
  })();

  // ExtendableMessageEvent 才有 waitUntil；真机上一定有，兜底避免抛错。
  if (typeof event.waitUntil === 'function') event.waitUntil(task);
});

/* ─────────────────────────  请求策略  ───────────────────────── */

/** 只缓存这些体积大、内容稳定的第三方运行时资源。 */
function isVendorRuntime(url) {
  return url.pathname.includes('/vendor/pdfjs/') || url.pathname.includes('/vendor/caj2pdf-rust/');
}

/** 这个 URL 是不是应用外壳文件。 */
function isShellFile(url) {
  return SHELL_FILES.some((f) => {
    if (f === './') return url.pathname === '/' || url.pathname.endsWith('/index.html');
    const p = f.replace('./', '/');
    return url.pathname === p || url.pathname.endsWith(p);
  });
}

/** 子资源（非导航）请求：目的或后缀命中即算。 */
function isSubresource(request, url) {
  if (request.mode === 'navigate') return false;
  if (request.destination && SUBRESOURCE_DEST.has(request.destination)) return true;
  return SUBRESOURCE_EXT.test(url.pathname);
}

/** 响应体是不是 HTML。 */
function isHtmlResponse(res) {
  const type = (res.headers.get('content-type') || '').toLowerCase();
  return type.includes('text/html');
}

/** 在 SHELL / VENDOR 两个缓存里找，返回第一个非 HTML 的命中。 */
async function matchUsableCache(request) {
  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit && !isHtmlResponse(hit)) return hit;
  return null;
}

/**
 * HTML 兜底页绝不能再往脚本 / 样式的位置送。
 * 但状态码要保留 —— 应用自己的启动探测靠 HTTP 401/404 判断被谁拦截。
 */
function htmlAsFailure(res) {
  const headers = new Headers();
  const original = res.headers.get('content-type');
  headers.set('content-type', 'text/plain; charset=utf-8');
  if (original) headers.set('x-caj-html-fallback', original);
  return new Response('', {
    status: res.status || 502,
    statusText: res.statusText || 'HTML fallback blocked',
    headers,
  });
}

/** 导航：缓存优先 + 后台更新；只有网络失败（离线）时才回退缓存。 */
async function handleNavigation(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch(async () => hit || cache.match('./index.html', { ignoreSearch: true }));
  return hit || network;
}

/** vendor 运行时：缓存优先；不缓存 HTML 兜底页与 206 分片。 */
async function handleVendor(request) {
  const cache = await caches.open(VENDOR);
  const hit = await cache.match(request);
  if (hit && !isHtmlResponse(hit)) return hit;
  const res = await fetch(request);
  // HTML 兜底页不能冒充脚本 / 样式 / wasm 下发。
  if (isHtmlResponse(res) && SUBRESOURCE_EXT.test(new URL(request.url).pathname)) {
    return htmlAsFailure(res);
  }
  if (res.ok && res.status === 200 && !request.headers.has('range') && !isHtmlResponse(res)) {
    cache.put(request, res.clone()).catch(() => {});
  }
  return res;
}

/** 其它子资源：网络优先，失败回退缓存；HTML 兜底页视为失败。 */
async function handleSubresource(request, url) {
  let res;
  try {
    res = await fetch(request);
  } catch {
    const hit = await matchUsableCache(request);
    if (hit) return hit;
    return new Response('', { status: 504, statusText: 'Network Error' });
  }

  if (isHtmlResponse(res)) {
    const hit = await matchUsableCache(request);
    return hit || htmlAsFailure(res);
  }

  if (!res.ok) {
    const hit = await matchUsableCache(request);
    if (hit) return hit;
    return res;
  }

  if (isShellFile(url)) {
    const cache = await caches.open(SHELL);
    cache.put(request, res.clone()).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // 不碰跨源请求

  // 导航请求：外壳缓存优先 + 后台更新，行为保持不变。
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // vendor 运行时：缓存优先。字体包与 WASM 有 60MB，命中缓存能省很多时间。
  if (isVendorRuntime(url)) {
    event.respondWith(handleVendor(request));
    return;
  }

  // 其它子资源：网络优先，绝不让 HTML 兜底页冒充脚本 / 样式。
  if (isSubresource(request, url)) {
    event.respondWith(handleSubresource(request, url));
    return;
  }

  // 其余请求直连网络，不缓存。
});
