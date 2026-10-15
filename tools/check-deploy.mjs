#!/usr/bin/env node
// 部署自检 —— 检查 GitHub Pages（或任何静态托管）上的 caj-viewer 是否完整可用。
//
// 为什么需要它：浏览器里看到的只是「首页能不能打开」，而白屏的真正原因往往藏在
// 某个子资源的 MIME 或 404 上（例如 .wasm 没被标成 application/wasm、.js 被
// SPA 回退成 text/html）。本脚本直接按 HTTP 检查每个关键文件。
//
// 用法（在 PowerShell 里）：
//   node tools/check-deploy.mjs
//   node tools/check-deploy.mjs https://pancaro-sama.github.io/caj-viewer/
//   node tools/check-deploy.mjs https://<你的域名>/           # 也可以查根路径部署
//
// 注意：本机 Windows TLS 栈（Schannel）是坏的，直接 curl/Invoke-WebRequest 会报
// SEC_E_NO_CREDENTIALS。所以本脚本在自己的进程内发请求，并请用
//   node --use-system-ca tools/check-deploy.mjs
// 启动（--use-system-ca 让它走 Windows 根证书库）。
//
// 为什么不 spawn 子进程：本项目的开发沙箱禁止 node 用管道 stdio 创建子进程
// （spawnSync EPERM），实测会得到一片 "no output" 的假失败。改成一个进程内完成。

import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';

const DEFAULT_BASE = 'https://pancaro-sama.github.io/caj-viewer/';
const base = (process.argv[2] || DEFAULT_BASE).replace(/\/?$/, '/');

// 期望的 MIME：太严格会误报，所以只检查「属于哪一类」。
// js   → 必须能被当作模块脚本执行
// wasm → 必须触发流式编译
// html → 首页
const EXPECT = [
  ['index.html', 'html'],
  ['app/app.js', 'js'],
  ['app/compat.js', 'js'],
  ['app/pinch.js', 'js'],
  ['app/pinch-math.js', 'js'],
  ['app/docs.js', 'js'],
  ['app/settings.js', 'js'],
  ['app/version.js', 'js'],
  ['app/style.css', 'css'],
  ['app/style-docs.css', 'css'],
  ['app/style-settings.css', 'css'],
  ['app/style-pinch.css', 'css'],
  ['app/icon-180.png', 'image'],
  ['app/icon-192.png', 'image'],
  ['sw.js', 'js'],
  ['manifest.webmanifest', 'json'],
  ['version.json', 'json'],
  ['vendor/caj2pdf-rust/browser.js', 'js'],
  ['vendor/caj2pdf-rust/io.js', 'js'],
  ['vendor/caj2pdf-rust/internal/worker.js', 'js'],
  ['vendor/caj2pdf-rust/internal/run.js', 'js'],
  ['vendor/caj2pdf-rust/caj2pdf_wasm.wasm', 'wasm'],
  ['vendor/pdfjs/build/pdf.min.js', 'js'],
  ['vendor/pdfjs/build/pdf.worker.min.js', 'js'],
  ['vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap', 'binary'],
  ['vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf', 'font'],
];

const CT_RULES = {
  html: (ct) => ct.includes('text/html'),
  js: (ct) => /javascript|ecmascript/.test(ct),
  css: (ct) => ct.includes('text/css'),
  json: (ct) => ct.includes('json'),
  wasm: (ct) => ct.includes('application/wasm'),
  image: (ct) => ct.startsWith('image/'),
  font: (ct) => /font|ttf|otf|woff/.test(ct),
  binary: (ct) => ct !== '' && !ct.includes('text/html'), // .bcmap 是什么类型都行，只要不是 HTML
};

// 在进程内发 HEAD 请求：只要状态码和 Content-Type，不要响应体。
// 大文件（wasm / 字体包）用 HEAD 不会下载内容，很快。
function probe(url, method = 'HEAD') {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(
      url,
      { method, headers: { 'User-Agent': 'caj-deploy-check' }, timeout: 30000 },
      (res) => {
        let len = 0;
        res.on('data', (c) => { len += c.length; if (len > 4096) res.destroy(); });
        res.on('end', () => resolve({
          s: res.statusCode,
          ct: (res.headers['content-type'] || '').split(';')[0],
          len: len || Number(res.headers['content-length'] || 0),
          loc: res.headers.location || '',
        }));
        res.on('close', () => resolve({
          s: res.statusCode,
          ct: (res.headers['content-type'] || '').split(';')[0],
          len: Number(res.headers['content-length'] || 0),
          loc: res.headers.location || '',
        }));
      },
    );
    req.on('error', (e) => resolve({ s: 0, ct: '', len: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ s: 0, ct: '', len: 0, err: 'timeout' }); });
    req.end();
  });
}

// HEAD 偶尔拿不到 Content-Type，非 200 时用 GET 复核一次（GET 只读前 4KB 就断开）。
async function head(url) {
  const r = await probe(url, 'HEAD');
  if (r.s === 200 && r.ct) return r;
  const g = await probe(url, 'GET');
  return g.s !== 0 ? g : r;
}

console.log(`检查目标：${base}\n`);
let pass = 0;
const fails = [];

for (const [path, kind] of EXPECT) {
  const r = await head(base + path);
  const okCt = r.s === 200 && CT_RULES[kind](r.ct || '');
  const size = r.len > 1024 * 1024 ? (r.len / 1024 / 1024).toFixed(1) + 'MB' : Math.round(r.len / 1024) + 'KB';
  const flag = okCt ? 'ok  ' : 'FAIL';
  console.log(`${flag} ${path.padEnd(52)} HTTP ${String(r.s).padEnd(4)} ${(r.ct || r.err || '-').padEnd(26)} ${r.s === 200 ? size : ''}`);
  if (okCt) pass += 1;
  else fails.push(`${path}  (HTTP ${r.s}${r.err ? ' ' + r.err : ''}${r.ct ? ', Content-Type: ' + r.ct : ''}, 期望 ${kind})`);
}

// 字体包是「可选但很重」的文件，单独提示，不计入失败。
const fontPack = await head(base + 'vendor/caj2pdf-rust/caj2pdf-fonts-v1.bin');
console.log('');
if (fontPack.s === 200) {
  console.log(`提示：字体包存在（${(fontPack.len / 1024 / 1024).toFixed(1)}MB）——C8/HN-B 原生文字页可用。`);
} else {
  console.log(`提示：没有字体包（HTTP ${fontPack.s}）——轻量部署，C8/HN-B 原生文字页会提示缺字体，属预期。`);
}

console.log(`\n结果：${pass}/${EXPECT.length} 通过`);
if (fails.length) {
  console.log('\n不合格项：');
  for (const f of fails) console.log('  - ' + f);
  console.log(`
常见原因：
  · 全是 404          → 发布目录选错了（应选仓库根 /，不是 /docs）
  · .js 是 text/html  → 托管商把未知路径 SPA 回退成了首页；确认文件真的推上去了
  · .wasm 不是 application/wasm → 服务器 MIME 表缺 wasm（本项目的 _headers 只在 Netlify/Cloudflare 生效）
  · 401/403           → 开了仓库访问保护/密码保护，会把 app/app.js 一起拦住，现象是「界面出来但点不动」`);
  process.exit(1);
}
console.log('\n全部通过：这个地址可以直接在 iPad Safari 打开（HTTPS 是安全上下文，SW/OPFS 都可用）。');
