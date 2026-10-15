#!/usr/bin/env node
/* ==========================================================================
 * 打包出一个可以直接上传到静态托管的 dist/ 目录。
 *
 *   node tools/make-dist.mjs                 完整打包（含 C8/HN-B 字体包，约 68 MB）
 *   node tools/make-dist.mjs --without-fonts 跳过 58.6 MB 字体包（约 9 MB）
 *
 * 什么时候需要 --without-fonts：
 *   · Cloudflare Pages 拒绝超过 25 MiB 的单个文件，完整包传不上去；
 *   · 只想快速分享给同事看普通期刊 CAJ，不需要 C8/HN-B 原生文字。
 * 代价：C8 / HN-B 的「原生文字页」会报错（图片页不受影响）。
 * ========================================================================== */

import { cp, mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const FONT_PACK = 'caj2pdf-fonts-v1.bin';
const withFonts = !process.argv.includes('--without-fonts');

/* 会上传到托管的内容。tests/ 与 docs/ 是开发用的，不进部署包。 */
const ITEMS = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  '_headers',
  'VERSION',
  'IPAD-UPDATE.md',
  'version.json',
  'app',
  'vendor',
  'serve.js',
  'start.cmd',
  'start.sh',
  'README.md',
  // 原地更新要用的脚本：没有它们，IPAD-UPDATE.md 里写的第一步在解压出来的
  // 包里会直接报「找不到文件」（曾经漏过）。只放运行时的两个，其余打包/图标
  // 脚本属于开发工具，不进部署包。
  //
  // 注意后缀：部署产物里**不能出现 .mjs**（很多托管不把它当 JavaScript 下发，
  // 浏览器模块图会被拒；见 tests/dist-smoke.mjs 的兜底断言）。这两个是 Node
  // 脚本，改名为 .js 后 node 依旧按 ESM 执行（package.json 里 type=module）。
  'tools/update-ipad.mjs',
  'tools/inject-version.mjs',
];

console.log(`\n打包到 ${DIST}`);
console.log(`字体包：${withFonts ? '包含' : '跳过（--without-fonts）'}\n`);

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

/* 运行时 Node 脚本在产物里换成 .js 后缀：node 仍按 ESM 执行（type=module），
   但产物不再含 .mjs，避免托管商 MIME 表把包弄坏。 */
const RENAME_IN_DIST = new Map([
  ['tools/update-ipad.mjs', 'tools/update-ipad.js'],
  ['tools/inject-version.mjs', 'tools/inject-version.js'],
]);

for (const item of ITEMS) {
  const from = join(ROOT, item);
  if (!existsSync(from)) {
    console.log(`  跳过（不存在）：${item}`);
    continue;
  }
  const target = RENAME_IN_DIST.get(item) || item;
  await cp(from, join(DIST, target), { recursive: true });
  console.log(`  + ${target}`);
}

/* 处理可选的字体包：它单独放在 vendor/caj2pdf-rust/ 下 */
const fontInDist = join(DIST, 'vendor', 'caj2pdf-rust', FONT_PACK);
if (!withFonts && existsSync(fontInDist)) {
  await rm(fontInDist, { force: true });
  console.log(`  - vendor/caj2pdf-rust/${FONT_PACK}`);
  // 留个说明，免得以后有人以为包丢了
  await writeFile(
    join(DIST, 'vendor', 'caj2pdf-rust', `${FONT_PACK}.REMOVED.txt`),
    '本部署包为了体积/上传限制，已删除 C8/HN-B 原生文字所需的字体包。\n'
    + '影响：C8 / HN-B 的「原生文字页」无法转换（图片页不受影响）。\n'
    + '恢复：从源码目录重新打包，或在托管上单独上传该文件到本目录。\n',
    'utf8',
  );
}

/* 统计 */
async function walk(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walk(full);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += (await stat(full)).size;
      files++;
    }
  }
  return { bytes, files };
}

const { bytes, files } = await walk(DIST);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

console.log(`\n共 ${files} 个文件，${mb(bytes)}`);
console.log(`位置：${relative(ROOT, DIST) || '.'}\n`);

/* 上传前的提醒 */
const biggest = [];
async function findBig(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await findBig(full);
    else {
      const { size } = await stat(full);
      if (size > 20 * 1024 * 1024) biggest.push([relative(DIST, full), size]);
    }
  }
}
await findBig(DIST);
if (biggest.length) {
  console.log('提醒：以下文件超过 20 MiB，部分托管商会拒绝（Cloudflare Pages 上限为 25 MiB）：');
  for (const [name, size] of biggest) console.log(`  · ${name}  ${mb(size)}`);
  console.log('  若上传失败，请改用 --without-fonts 重新打包，或换 Netlify / GitHub Pages。\n');
}

console.log('接下来：');
console.log('  · 想在电脑上先验证：   node dist/serve.js --port 8080');
console.log('  · 拖拽式托管：         把 dist/ 整个拖到 https://app.netlify.com/drop');
console.log('  · 上传后：             用 iPad Safari 打开 HTTPS 地址 → 分享 → 添加到主屏幕\n');
