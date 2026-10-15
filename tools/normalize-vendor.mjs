#!/usr/bin/env node
/* ==========================================================================
 * 把 vendor/ 里的 .mjs / .d.mts 统一改名成 .js / .d.ts，并重写文件内部
 * 引用这些文件的模块说明符。
 *
 *   node tools/normalize-vendor.mjs
 *
 * 为什么必须做：
 *   很多静态托管并不把 .mjs 当成 JavaScript 下发，而是 application/octet-stream
 *   或 text/plain。浏览器对「模块脚本」执行的是**严格 MIME 检查**，不匹配就直接
 *   拒绝执行 —— 整个模块图加载失败，页面表现成「界面出来了、脚本没跑」。
 *   而且报错信息很有迷惑性：入口文件自己是好的，报出来的是
 *   "Failed to fetch dynamically imported module"，指向的是入口而不是真正出错的依赖。
 *
 *   .js 是任何托管都正确处理的后缀，统一成 .js 等于从根上消掉这一类故障。
 *   该脚本是幂等的，可以反复运行。
 * ========================================================================== */

import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VENDOR = join(ROOT, 'vendor');

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

/* ── 1. 改名 ─────────────────────────────────────────────── */

let renamed = 0;
for (const file of await walk(VENDOR)) {
  if (file.endsWith('.mjs')) {
    await rename(file, `${file.slice(0, -4)}.js`);
    console.log(`  ${rel(file)}  →  ${rel(file.slice(0, -4))}.js`);
    renamed++;
  } else if (file.endsWith('.d.mts')) {
    await rename(file, `${file.slice(0, -6)}.d.ts`);
    console.log(`  ${rel(file)}  →  ${rel(file.slice(0, -6))}.d.ts`);
    renamed++;
  }
}

/* ── 2. 重写文件内的模块说明符 ───────────────────────────── */

// 只命中「被引号包住、且以 .mjs / .d.mts 结尾」的字符串。
// 先处理更具体的 .d.mts，再处理 .mjs。
const D_MTS = /(["'])([^"'\r\n]*?)\.d\.mts\1/g;
const MJS = /(["'])([^"'\r\n]*?)\.mjs\1/g;

let rewritten = 0;
const touched = [];
for (const file of await walk(VENDOR)) {
  if (!/\.(js|ts)$/.test(file)) continue;
  const before = await readFile(file, 'utf8');
  const after = before.replace(D_MTS, '$1$2.d.ts$1').replace(MJS, '$1$2.js$1');
  if (after !== before) {
    await writeFile(file, after, 'utf8');
    touched.push(rel(file));
    rewritten++;
  }
}

console.log(`\n改名 ${renamed} 个文件，重写 ${rewritten} 个文件的模块说明符。`);
if (touched.length) for (const f of touched) console.log(`  改写：${f}`);

/* ── 3. 自检：vendor 里不该再有任何 .mjs / .mts ───────────── */

const left = (await walk(VENDOR)).filter((f) => f.endsWith('.mjs') || f.endsWith('.mts'));
if (left.length) {
  console.error('\n仍然残留 .mjs / .mts：');
  for (const f of left) console.error(`  ${rel(f)}`);
  process.exit(1);
}
console.log('自检通过：vendor/ 中已无 .mjs / .mts 文件。\n');
