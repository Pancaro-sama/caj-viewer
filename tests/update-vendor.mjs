#!/usr/bin/env node
/* ==========================================================================
 * 把 vendor/ 里的第三方运行时升级到 package.json 中声明的新版本。
 *
 *   node tests/update-vendor.mjs
 *
 * 只在需要升级时才用得到；平时运行应用完全不需要 npm，也不需要本脚本。
 * ========================================================================== */

import { spawn } from 'node:child_process';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STAGE = join(ROOT, '.vendor-stage');
const CACHE = join(ROOT, '.npm-cache');

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const CAJ = pkg.devDependencies['caj2pdf-rust'];
const PDFJS = pkg.devDependencies['pdfjs-dist'];

console.log(`准备拉取 caj2pdf-rust@${CAJ} 与 pdfjs-dist@${PDFJS} …`);

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
await mkdir(CACHE, { recursive: true });

await run('npm', [
  'install',
  '--no-save', '--no-audit', '--no-fund', '--loglevel=error',
  '--cache', CACHE,
  `caj2pdf-rust@${CAJ}`,
  `pdfjs-dist@${PDFJS}`,
], STAGE);

const src = join(STAGE, 'node_modules');
const vendor = join(ROOT, 'vendor');

/* ── caj2pdf-rust：整个包都要（入口 + Worker + WASM + 字体包） ── */
const cajSrc = join(src, 'caj2pdf-rust');
const cajDst = join(vendor, 'caj2pdf-rust');
await rm(cajDst, { recursive: true, force: true });
await mkdir(cajDst, { recursive: true });
for (const f of ['browser.mjs', 'browser.d.mts', 'io.mjs', 'io.d.mts', 'node.mjs', 'node.d.mts',
  'caj2pdf_wasm.wasm', 'caj2pdf-fonts-v1.bin', 'LICENSE', 'FONT-NOTICES.txt', 'README.md']) {
  if (existsSync(join(cajSrc, f))) await cp(join(cajSrc, f), join(cajDst, f));
}
await cp(join(cajSrc, 'internal'), join(cajDst, 'internal'), { recursive: true });

/* ── pdfjs-dist：只要运行时真正用到的部分 ── */
const pdfSrc = join(src, 'pdfjs-dist');
const pdfDst = join(vendor, 'pdfjs');
await rm(pdfDst, { recursive: true, force: true });
await mkdir(join(pdfDst, 'build'), { recursive: true });

// 标准构建（不是 legacy）。legacy 构建是 ESM，且很多托管不把 .mjs 当 JS 下发；
// 旧版 Safari 的 API 差距由 app/compat.js 垫片解决，见 README「浏览器要求」。
await cp(join(pdfSrc, 'build', 'pdf.min.mjs'), join(pdfDst, 'build', 'pdf.min.mjs'));
await cp(join(pdfSrc, 'build', 'pdf.worker.min.mjs'), join(pdfDst, 'build', 'pdf.worker.min.mjs'));
await cp(join(pdfSrc, 'web', 'pdf_viewer.css'), join(pdfDst, 'pdf_viewer.css'));
await cp(join(pdfSrc, 'LICENSE'), join(pdfDst, 'LICENSE'));

for (const [from, to] of [['cmaps', 'cmaps'], ['standard_fonts', 'standard_fonts'], ['iccs', 'iccs']]) {
  await cp(join(pdfSrc, from), join(pdfDst, to), { recursive: true });
}
// 只保留 wasm 二进制，不要体积大且用不到的 JS 回退实现
await mkdir(join(pdfDst, 'wasm'), { recursive: true });
for (const f of ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm', 'quickjs-eval.wasm']) {
  if (existsSync(join(pdfSrc, 'wasm', f))) await cp(join(pdfSrc, 'wasm', f), join(pdfDst, 'wasm', f));
}

await rm(STAGE, { recursive: true, force: true });
await writeFile(join(vendor, 'VERSIONS.txt'),
  `caj2pdf-rust  ${CAJ}\npdfjs-dist    ${PDFJS}  (standard build)\n`, 'utf8');

// 上游发布的是 .mjs。很多托管不把 .mjs 当 JavaScript 下发，浏览器会因严格 MIME
// 检查拒绝执行整个模块图。统一改名成 .js，从根上消掉这一类部署故障。
await run(process.execPath, [join(ROOT, 'tools', 'normalize-vendor.mjs')], ROOT);

console.log('\nvendor/ 已更新：');
console.log(`  caj2pdf-rust  ${CAJ}`);
console.log(`  pdfjs-dist    ${PDFJS} (standard build)`);
console.log('\n注意：若 pdf.js 的 wasm 解码器 / 标准字体 / CMap 文件名有变化，');
console.log('      sw.js 里 VENDOR_FILES 的离线预热清单要同步更新；');
console.log('      node tests/dist-smoke.mjs 会核对清单里的每个路径是否真实存在。');
console.log('\n建议接着运行：  node tests/make-fixtures.mjs && node tests/smoke.mjs && node tests/browser-e2e.mjs && node tools/make-dist.mjs && node tests/dist-smoke.mjs');

/** 跨平台地跑一条命令，并把输出直接透传（不使用管道，避免受限环境下被拦）。 */
function run(cmd, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} 退出码 ${code}`));
    });
  });
}
