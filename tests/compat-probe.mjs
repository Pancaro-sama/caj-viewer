#!/usr/bin/env node
/* ==========================================================================
 * iPadOS 兼容下限探针
 *
 *   node tests/compat-probe.mjs
 *
 * 纯只读：扫描 vendor/ 运行时与 app/app.js 里用到的「较新的语法 / 标准 API」，
 * 把命中的特性名打出来。用途是**升级 vendor 之后人工核对兼容下限是否被推高** ——
 * 这些特性一旦出现，就需要往 app/compat.js 里加对应的垫片（能垫的）或
 * 提高文档里的最低系统版本（垫不了的语法）。
 *
 * 它不参与 npm test（没有断言、也不需要浏览器），是排查时的辅助工具。
 * ========================================================================== */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const targets = [
  'vendor/pdfjs/build/pdf.min.js',
  'vendor/pdfjs/build/pdf.worker.min.js',
  'app/app.js',
  'app/compat.js',
  'vendor/caj2pdf-rust/browser.js',
  'vendor/caj2pdf-rust/io.js',
  'vendor/caj2pdf-rust/internal/worker.js',
  'vendor/caj2pdf-rust/internal/run.js',
  'vendor/caj2pdf-rust/internal/bundled-fonts.js',
  'vendor/caj2pdf-rust/internal/font-pack.js',
];

const feats = {
  // 可以用 app/compat.js 垫掉的方法
  'Promise.withResolvers': /withResolvers/,
  'Object.hasOwn': /Object\.hasOwn/,
  'Array.prototype.at(': /\.at\(-?\d/,
  'Array.findLast': /findLast(Index)?\(/,
  'Array.prototype.with(': /\.with\(/,
  'Uint8Array.fromBase64': /fromBase64/,
  'Uint8Array.fromHex': /fromHex/,
  'Promise.any': /Promise\.any/,
  'String.replaceAll': /replaceAll\(/,
  // 垫不掉的语法：只能抬高最低系统版本
  '#private field': /#[A-Za-z_$][\w$]*=/,
  'static{ block': /static\s*\{/,
  'class static field': /class\s+\w*[^{]*\{[^}]*\bstatic\s+\w+\s*=/,
  'top-level await': /^\s*await\s/m,
  '??=': /\?\?=/,
  '||=': /\|\|=/,
  '&&=': /&&=/,
  // 运行时能力，缺失时要显式降级而不能直接崩
  structuredClone: /structuredClone/,
  WeakRef: /WeakRef/,
  FinalizationRegistry: /FinalizationRegistry/,
  OffscreenCanvas: /OffscreenCanvas/,
  createImageBitmap: /createImageBitmap/,
  'ReadableStream.from': /ReadableStream\.from/,
  'AbortSignal.timeout': /AbortSignal\.timeout/,
  'navigator.gpu': /navigator\.gpu/,
  'URLPattern': /URLPattern/,
  'Intl.Segmenter': /Segmenter/,
  'Intl.ListFormat': /ListFormat/,
};

console.log('iPadOS 兼容下限探针（升级 vendor 后请人工核对）\n');

for (const target of targets) {
  const file = resolve(ROOT, target);
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    console.log(`### ${target}: 读不到（跳过）`);
    continue;
  }
  const kb = (statSync(file).size / 1024).toFixed(0);
  const hits = Object.entries(feats).filter(([, re]) => re.test(src)).map(([name]) => name);
  console.log(`### ${target}  (${kb} KB)`);
  console.log(hits.length ? `    ${hits.join(', ')}` : '    （未命中探针里的任何特性）');
}

console.log('\n提醒：命中「垫不掉」的那一组时，README 与 docs/ipad-deploy.md 的最低系统版本要同步上调。');
