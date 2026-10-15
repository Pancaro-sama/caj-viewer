#!/usr/bin/env node
/* ==========================================================================
 * CAJ 阅读器 — 零依赖本地静态服务器
 *
 * 为什么需要它：浏览器的模块 Worker、WebAssembly 流式编译和 OPFS 都要求
 * 「安全上下文」（https 或 localhost）。直接 file:// 打开 index.html 会失败。
 * 本脚本只做静态文件分发，不做任何解析或上传。
 *
 *   用法： node serve.js [--port 8080] [--host 0.0.0.0] [--no-isolation]
 *
 * 默认绑定 0.0.0.0，这样同一局域网内的 iPad 可以直接访问。
 * ========================================================================== */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(argOf('port', process.env.PORT || 8080));
const HOST = argOf('host', '0.0.0.0');
const ISOLATION = !process.argv.includes('--no-isolation');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'font/type1',
  '.bcmap': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.caj': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function baseHeaders(extra = {}) {
  const headers = {
    // 禁止任何形式的缓存代理嗅探；文件全部是本机的
    'X-Content-Type-Options': 'nosniff',
    // 所有资源都是同源的，明确声明以免 COEP 拦掉自己
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
  if (ISOLATION) {
    // 让页面成为 crossOriginIsolated：启用 SharedArrayBuffer，
    // 转换器才能对 Worker 施加背压并即时取消。
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }
  return headers;
}

/** 把 URL 路径安全地映射到 ROOT 之内的真实路径。 */
function safeResolve(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (!p.startsWith('/')) p = `/${p}`;
  const rel = normalize(p).replace(/^([/\\])+/, '');
  const abs = resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

function notFound(res) {
  res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end('404 Not Found');
}

/** 极简 Range 支持：大文件（字体包 / PDF）拖动进度条时更省流量。 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {                       // bytes=-N  末尾 N 字节
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }));
    res.end('Method Not Allowed');
    return;
  }

  const target = safeResolve(req.url || '/');
  if (!target) return notFound(res);

  let info = await stat(target).catch(() => null);
  let file = target;

  if (info?.isDirectory()) {
    file = join(target, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) return notFound(res);

  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const common = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString(),
    // 开发/本地场景：始终拿最新文件，避免改了代码却看到旧的
    'Cache-Control': 'no-cache',
  };

  const range = parseRange(req.headers.range, info.size);
  if (range) {
    res.writeHead(206, baseHeaders({
      ...common,
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': String(range.end - range.start + 1),
    }));
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, baseHeaders({ ...common, 'Content-Length': String(info.size) }));
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。换一个端口，例如：  node serve.js --port 8081\n`);
  } else {
    console.error('\n  服务器启动失败：', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  CAJ 阅读器 已启动（纯本地静态服务，文件不出本机）');
  console.log(line);
  console.log(`  本机：      http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) {
    console.log(`  局域网：    http://${ip}:${PORT}/   ← iPad / 手机用这个`);
  }
  console.log(`  服务目录：  ${ROOT}`);
  console.log(`  跨源隔离：  ${ISOLATION ? '已启用（SharedArrayBuffer 可用）' : '已关闭'}`);
  console.log(`${line}`);
  console.log('  按 Ctrl+C 停止\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
