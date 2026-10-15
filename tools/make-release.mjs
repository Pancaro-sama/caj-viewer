#!/usr/bin/env node
/* ==========================================================================
 * 把部署产物打成可以直接 AirDrop 到 iPad 的 zip。
 *
 *   node tools/make-release.mjs
 *
 * 产物落在 release/：
 *   caj-viewer-ipad-full.zip   完整版，含 58.6 MB 字体包，约 66 MB（含 C8/HN-B 原生文字页）
 *   caj-viewer-ipad-lite.zip   轻量版，不含字体包，约 9 MB
 *   iPad-使用说明.md            从 docs/ipad-users.md 复制而来，供 AirDrop 时一起发过去
 *   SHA256SUMS.txt             两个包的校验和
 *
 * zip 里只有一层 caj-viewer/ 目录，在 iPad 上解压后可以直接移动进 a-Shell 目录。
 *
 * 注意：完整版必须**先**打包，因为 make-dist.mjs --without-fonts 会把上一次留在
 * dist/ 里的字体包删掉；所以顺序固定为「完整版 → 轻量版 → 重建完整 dist」。
 * ========================================================================== */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const RELEASE = join(ROOT, 'release');
const FONT_PACK = join(DIST, 'vendor', 'caj2pdf-rust', 'caj2pdf-fonts-v1.bin');
const ZIP_ROOT = join(RELEASE, 'caj-viewer');

/** zip 里名字（ASCII，避开 Airdrop/归档工具对中文文件名的编码差异）。 */
const PACKED_DOC = 'IPAD-DEPLOY.md';

const node = process.execPath;
const run = (args, label) => {
  process.stdout.write(`\n▶ ${label}\n`);
  execFileSync(node, args, { cwd: ROOT, stdio: 'inherit' });
};

/* zip 里要带的东西：部署产物 + iPad 使用说明。 */
const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function zip(outputName) {
  const output = join(RELEASE, outputName);
  rmSync(output, { force: true });
  // Windows 10+ / macOS 都自带 bsdtar：-a 由扩展名决定 zip 格式。
  execFileSync('tar', ['-a', '-c', '-f', output, '-C', RELEASE, 'caj-viewer'], { stdio: 'inherit' });
  const bytes = statSync(output).size;
  const sha = createHash('sha256').update(readFileSync(output)).digest('hex');
  console.log(`✔ ${outputName}  ${mb(bytes)}  sha256=${sha}`);
  return { name: outputName, bytes, sha };
}

/** 从 dist/ 组装 zip 里那一层 caj-viewer/ 目录。 */
function stage(fonts) {
  rmSync(ZIP_ROOT, { recursive: true, force: true });
  mkdirSync(ZIP_ROOT, { recursive: true });
  cpSync(DIST, ZIP_ROOT, { recursive: true });
  cpSync(DOC_SRC, join(ZIP_ROOT, PACKED_DOC));

  const font = join(ZIP_ROOT, 'vendor', 'caj2pdf-rust', 'caj2pdf-fonts-v1.bin');
  if (!fonts) {
    // make-dist --without-fonts 应该已经删掉了；这里再兜一层，防止误打包 58 MB。
    rmSync(font, { force: true });
    rmSync(`${font}.REMOVED.txt`, { force: true });
  }

  // 自检：关键运行时一个都不能少，否则 iPad 上会白屏。
  const required = [
    'index.html',
    'manifest.webmanifest',
    'sw.js',
    'app/app.js',
    'app/compat.js',
    'app/style.css',
    'app/icon-180.png',
    'app/icon-192.png',
    'app/icon-512.png',
    'vendor/pdfjs/build/pdf.min.js',
    'vendor/pdfjs/build/pdf.worker.min.js',
    'vendor/caj2pdf-rust/browser.js',
    'vendor/caj2pdf-rust/io.js',
    'vendor/caj2pdf-rust/caj2pdf_wasm.wasm',
    'vendor/caj2pdf-rust/internal/worker.js',
    'vendor/caj2pdf-rust/internal/run.js',
    'vendor/caj2pdf-rust/internal/bundled-fonts.js',
    'vendor/caj2pdf-rust/internal/font-pack.js',
  ];
  const missing = required.filter((p) => !existsSync(join(ZIP_ROOT, p)));
  if (missing.length) {
    throw new Error(`打包缺少必需文件：${missing.join(', ')}`);
  }
  if (existsSync(join(ZIP_ROOT, 'app/app.mjs')) || existsSync(join(ZIP_ROOT, 'app/app.css.mjs'))) {
    throw new Error('打包里出现了 .mjs，托管商 MIME 可能不认');
  }
  const hasFont = existsSync(font);
  if (hasFont !== fonts) {
    throw new Error(`字体包状态不对：期望 ${fonts ? '包含' : '不含'}，实际 ${hasFont ? '包含' : '不含'}`);
  }
  const count = (function walk(dir) {
    let n = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      n += e.isDirectory() ? walk(join(dir, e.name)) : 1;
    }
    return n;
  })(ZIP_ROOT);
  console.log(`  组装完成：${count} 个文件；字体包：${hasFont ? `包含（${mb(sizeOf(font))}）` : '不含'}`);
  return { count, font: hasFont ? sizeOf(font) : 0 };
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */

const DOC_SRC = join(ROOT, 'docs', 'ipad-users.md');

mkdirSync(RELEASE, { recursive: true });
rmSync(ZIP_ROOT, { recursive: true, force: true });

console.log('① 打包完整版（含字体包）');
run(['tools/make-dist.mjs'], 'make-dist（完整）');
stage(true);
const full = zip('caj-viewer-ipad-full.zip');

console.log('\n② 打包轻量版（不含字体包）');
run(['tools/make-dist.mjs', '--without-fonts'], 'make-dist --without-fonts');
stage(false);
const lite = zip('caj-viewer-ipad-lite.zip');

console.log('\n③ 把 dist/ 还原成完整版（否则 dist 里会一直缺字体包）');
run(['tools/make-dist.mjs'], 'make-dist（还原完整）');
if (!existsSync(FONT_PACK)) {
  throw new Error('dist/ 还原失败：字体包不在');
}

cpSync(DOC_SRC, join(RELEASE, PACKED_DOC));
writeFileSync(
  join(RELEASE, 'SHA256SUMS.txt'),
  `${full.sha}  ${full.name}\n${lite.sha}  ${lite.name}\n`,
  'utf8',
);

rmSync(ZIP_ROOT, { recursive: true, force: true });

console.log(`
────────────────────────────────────────
产物目录：release/
  ${full.name}   ${mb(full.bytes)}   （含字体包，推荐）
  ${lite.name}   ${mb(lite.bytes)}   （不含字体包）
  ${PACKED_DOC}
  SHA256SUMS.txt

发给 iPad 之后：解压 → 把 caj-viewer 文件夹移进「文件」App 的 a-Shell 目录，然后
  cd ~/Documents/caj-viewer && python3 -m http.server 8080
Safari 打开 http://localhost:8080
────────────────────────────────────────`);
