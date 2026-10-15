// SPDX-License-Identifier: MIT

/**
 * 对「即将上传到托管」的 dist/ 做一次冒烟检查。
 *
 *   node tools/make-dist.mjs && node tests/dist-smoke.mjs
 *
 * 部署到 iPad 最常见的几种翻车方式都在这里挡住：
 *   · 只传了 index.html，app/ 和 vendor/ 没上去
 *   · .wasm 被发成 application/octet-stream，流式编译直接失败
 *   · manifest / sw.js 404，导致装不到主屏幕
 *   · 缺少 COOP/COEP，拿不到跨源隔离
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = resolve(ROOT, 'dist');

if (!existsSync(DIST)) {
  console.error('找不到 dist/，请先运行：  node tools/make-dist.mjs');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

// stdio 必须是 ignore：受限环境下无法创建命名管道
const server = spawn(process.execPath, ['serve.js', '--port', String(PORT), '--host', '127.0.0.1'], {
  cwd: DIST, stdio: 'ignore', windowsHide: true,
});

try {
  // 等服务起来
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/index.html`)).ok) break; } catch { /* 还没起来 */ }
    if (i > 100) throw new Error('静态服务启动超时');
    await sleep(120);
  }

  const shell = await fetch(`${BASE}/index.html`);
  const shellText = await shell.text();
  check('index.html 可访问且是应用外壳',
    shell.ok && shellText.includes('CAJ 阅读器'),
    `HTTP ${shell.status}, ${shell.headers.get('content-type')}`);

  // 这些任何一个 404，页面就会白屏或功能缺失
  const must = [
    ['/app/app.js', 'javascript'],
    ['/app/style.css', 'text/css'],
    ['/app/compat.js', 'javascript'],
    ['/app/pinch.js', 'javascript'],
    ['/app/pinch-math.js', 'javascript'],
    ['/app/docs.js', 'javascript'],
    ['/app/settings.js', 'javascript'],
    ['/app/version.js', 'javascript'],
    ['/app/style-docs.css', 'text/css'],
    ['/app/style-settings.css', 'text/css'],
    ['/app/style-pinch.css', 'text/css'],
    ['/vendor/caj2pdf-rust/browser.js', 'javascript'],
    ['/vendor/caj2pdf-rust/internal/worker.js', 'javascript'],
    ['/vendor/pdfjs/build/pdf.min.js', 'javascript'],
    ['/vendor/pdfjs/build/pdf.worker.min.js', 'javascript'],
    ['/vendor/pdfjs/pdf_viewer.css', 'text/css'],
    ['/manifest.webmanifest', 'manifest'],
    ['/sw.js', 'javascript'],
    ['/_headers', ''],
    ['/app/icon.svg', 'svg'],
    // 原地更新脚本：IPAD-UPDATE.md 让用户跑的第一条命令就是它，
    // 漏进产物会让随包更新直接报「找不到文件」。
    // 产物里用 .js 后缀（部署产物不允许出现 .mjs）。
    ['/tools/update-ipad.js', 'javascript'],
    ['/tools/inject-version.js', 'javascript'],
  ];
  const missing = [];
  for (const [path, expectType] of must) {
    const r = await fetch(BASE + path);
    const type = r.headers.get('content-type') || '';
    if (!r.ok || (expectType && !type.includes(expectType))) {
      missing.push(`${path}(HTTP ${r.status}, ${type || '无类型'})`);
    }
  }
  check(`${must.length} 个必需资源全部可访问且 MIME 正确`,
    missing.length === 0, missing.join(', '));

  // 关键不变量：部署产物里不能有 .mjs。
  // 很多托管（含 Netlify）不把 .mjs 当 JavaScript 下发，而浏览器对模块脚本执行
  // 严格 MIME 检查，会直接拒绝执行整个模块图 —— 页面表现成「界面在、脚本没跑」，
  // 而且报错指向入口文件，很有迷惑性。统一用 .js 就从根上不依赖托管的 MIME 表。
  const badExt = [];
  async function scanExtensions(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await scanExtensions(full);
      else if (/\.(mjs|mts)$/.test(full)) badExt.push(relative(DIST, full));
    }
  }
  await scanExtensions(DIST);
  check('部署产物中不含 .mjs / .mts（不依赖托管商的 MIME 表）',
    badExt.length === 0, badExt.slice(0, 5).join(', '));

  // .wasm 的 MIME 是硬性要求：compileStreaming 会对它做严格校验
  const wasm = await fetch(`${BASE}/vendor/caj2pdf-rust/caj2pdf_wasm.wasm`);
  const wasmType = wasm.headers.get('content-type') || '';
  const wasmBytes = (await wasm.arrayBuffer()).byteLength;
  check('转换引擎 .wasm 可下载且 MIME 为 application/wasm',
    wasm.ok && wasmType.includes('application/wasm') && wasmBytes > 100000,
    `HTTP ${wasm.status}, ${wasmType}, ${(wasmBytes / 1024).toFixed(0)} KB`);

  // pdf.js 的解码器：JBIG2 是 CAJ 扫描件的主力编码
  const jbig2 = await fetch(`${BASE}/vendor/pdfjs/wasm/jbig2.wasm`);
  check('pdf.js 的 JBIG2 解码器就位（CAJ 扫描件依赖它）',
    jbig2.ok && (jbig2.headers.get('content-type') || '').includes('application/wasm'),
    `HTTP ${jbig2.status}`);

  // pdf.js 需要的中日韩字符映射表（CNKI 的 CID 字体要用）
  const cmap = await fetch(`${BASE}/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap`);
  check('中文 CMap 就位（CNKI 的 CID 字体要用）', cmap.ok, `HTTP ${cmap.status}`);

  // 离线预热清单必须与真实产物一致：清单里任何一个路径在 dist 里不存在，
  // 断网后第一次打开就会缺文件（而且往往是在 import 阶段直接失败）。
  // 这条检查同时兜住「改了 pdf.js 资源、忘了更新 sw.js 清单」的回归。
  const swSource = await readFile(join(DIST, 'sw.js'), 'utf8');
  const vendorBlock = swSource.match(/const VENDOR_FILES = \[([\s\S]*?)\n\];/)?.[1] || '';
  const vendorList = [...vendorBlock.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
  // 字体包是唯一允许缺席的项：--without-fonts 的轻量产物本来就不含它，
  // 此时预热会把它记为一项失败，功能不受影响。
  const vendorMissing = vendorList
    .filter((p) => !p.endsWith('caj2pdf-fonts-v1.bin'))
    .filter((p) => !existsSync(join(DIST, p)));
  check(`离线预热清单全部存在于产物中（${vendorList.length} 项）`,
    vendorList.length > 0 && vendorMissing.length === 0,
    vendorMissing.slice(0, 5).join(', '));

  // 跨源隔离：决定能否拿到 SharedArrayBuffer
  check('带上了 COOP / COEP（可启用跨源隔离）',
    (shell.headers.get('cross-origin-opener-policy') || '').includes('same-origin')
    && (shell.headers.get('cross-origin-embedder-policy') || '').includes('require-corp'),
    `COOP=${shell.headers.get('cross-origin-opener-policy')} `
    + `COEP=${shell.headers.get('cross-origin-embedder-policy')}`);

  // 字体包按需加载：完整包应该有，--without-fonts 打包则应当没有
  const fonts = await fetch(`${BASE}/vendor/caj2pdf-rust/caj2pdf-fonts-v1.bin`);
  const hasFonts = fonts.ok && Number(fonts.headers.get('content-length') || 0) > 1000000;
  console.log(`\n  字体包：${hasFonts ? '已包含（C8/HN-B 原生文字可用）'
    : '未包含（C8/HN-B 原生文字将不可用，其余格式不受影响）'}`);

  // 目录穿越必须被挡住
  const traversal = await fetch(`${BASE}/../package.json`);
  check('拒绝目录穿越访问', !traversal.ok || !(await traversal.text()).includes('devDependencies'),
    `HTTP ${traversal.status}`);

  const nope = await fetch(`${BASE}/does-not-exist.txt`);
  check('不存在的路径返回 404', nope.status === 404, `HTTP ${nope.status}`);

} catch (err) {
  check('检查流程本身未抛异常', false, err.message);
} finally {
  server.kill();
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${'─'.repeat(58)}`);
console.log(`检查项：${results.length}   通过：${passed}   失败：${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name} — ${r.detail}`);
}
console.log(`${failed ? 'FAIL' : 'PASS'}\n`);
process.exit(failed ? 1 : 0);
