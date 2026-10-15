#!/usr/bin/env node
/* ==========================================================================
 * 在 iPad（a-Shell）或电脑上原地更新 caj-viewer。
 *
 * 用法（在**旧版本目录里**执行）：
 *   node tools/update-ipad.mjs --from ~/Documents/caj-viewer-new
 *   node tools/update-ipad.mjs --from ~/Documents/caj-viewer-ipad-full.zip
 *   node tools/update-ipad.mjs --list
 *   node tools/update-ipad.mjs --rollback
 *   node tools/update-ipad.mjs --from <src> --dry-run     # 只检查，不落盘
 *
 * 做法（笔记类 App 的更新方式，重点是不丢书签/设置，出问题能回退）：
 *   1. 校验来源：必须有 index.html / app/app.js / app/compat.js / vendor/…（缺一个就中止）
 *   2. 把当前版本整目录复制成 .releases/<旧版本>-<时间戳>/
 *   3. 只覆盖「程序文件」，**保留用户数据**：设置、最近文件索引都由浏览器 localStorage /
 *      IndexedDB 保存，不在这份目录里，因此天然不受影响；目录里若残留别的文件也不删。
 *   4. 更新 .caj-version.json（记录版本、时间、来源）
 *   5. 打印回退命令与「回 a-Shell 重启服务」的提示
 *
 * 不依赖任何 npm 依赖，只用 node 内置模块。
 * ========================================================================== */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RELEASES_DIR = join(HERE, '.releases');
const STAMP_FILE = join(HERE, '.caj-version.json');
const KEEP_RELEASES = 3;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};

/** 必须存在的文件：少一个就会白屏，宁可不更新。 */
const REQUIRED = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'app/app.js',
  'app/compat.js',
  'app/style.css',
  'vendor/pdfjs/build/pdf.min.js',
  'vendor/pdfjs/build/pdf.worker.min.js',
  'vendor/caj2pdf-rust/browser.js',
  'vendor/caj2pdf-rust/caj2pdf_wasm.wasm',
  'vendor/caj2pdf-rust/internal/worker.js',
];

const say = (s) => process.stdout.write(`${s}\n`);
const die = (s) => { process.stderr.write(`✖ ${s}\n`); process.exit(1); };

const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const human = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

async function readStamp() {
  try { return JSON.parse(await readFile(STAMP_FILE, 'utf8')); } catch { return null; }
}

/** 找 .releases 下最近的一次备份（按目录名倒序）。 */
async function listReleases() {
  if (!existsSync(RELEASES_DIR)) return [];
  const names = (await readdir(RELEASES_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  return names;
}

/** 用 bsdtar / tar 解 zip；Windows 10+ 与 macOS 都自带。 */
function unzipTo(zipPath, dest) {
  const tools = process.platform === 'win32' ? ['tar'] : ['tar', 'unzip'];
  for (const tool of tools) {
    try {
      execFileSync(tool, tool === 'unzip' ? ['-q', zipPath, '-d', dest] : ['-x', '-f', zipPath, '-C', dest], { stdio: 'ignore' });
      return true;
    } catch { /* 换下一个 */ }
  }
  return false;
}

/** 统一把来源整理成一个「有 index.html 的目录」。 */
async function resolveSource(src) {
  if (!existsSync(src)) die(`来源不存在：${src}`);
  const info = await stat(src);
  if (info.isDirectory()) return { dir: src, temp: null };

  if (!/\.zip$/i.test(src)) die(`来源既不是目录也不是 zip：${src}`);
  const dest = join(HERE, `.update-tmp-${timestamp()}`);
  await mkdir(dest, { recursive: true });
  if (!unzipTo(src, dest)) {
    await rm(dest, { recursive: true, force: true });
    die('解压 zip 失败：这台机器上没有可用的 tar / unzip。请先在「文件」App 里解压，再用 --from 指向解压出来的目录。');
  }
  // zip 里可能包了一层 caj-viewer/
  const entries = await readdir(dest, { withFileTypes: true });
  const onlyDir = entries.length === 1 && entries[0].isDirectory();
  const inside = onlyDir ? join(dest, entries[0].name) : dest;
  if (existsSync(join(inside, 'index.html'))) return { dir: inside, temp: dest };
  if (existsSync(join(dest, 'index.html'))) return { dir: dest, temp: dest };
  await rm(dest, { recursive: true, force: true });
  die(`解压出来的目录里没有 index.html（${basename(src)}）`);
}

async function dirSize(dir) {
  let bytes = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) bytes += await dirSize(full);
    else bytes += (await stat(full)).size;
  }
  return bytes;
}

/* ── 分支：--list ─────────────────────────────────────────────────────── */
if (flag('--list')) {
  const stamp = await readStamp();
  say(`当前版本：${stamp ? `${stamp.app}（更新于 ${stamp.updatedAt}）` : '未知（还没有用本脚本更新过）'}`);
  const rel = await listReleases();
  say(rel.length ? `\n可用备份（新 → 旧）：\n  ${rel.join('\n  ')}` : '\n还没有备份。');
  process.exit(0);
}

/* ── 分支：--rollback ────────────────────────────────────────────────── */
if (flag('--rollback')) {
  const rel = await listReleases();
  if (!rel.length) die('没有可回退的备份。');
  const target = join(RELEASES_DIR, rel[0]);
  say(`回退到：${rel[0]}`);
  for (const item of await readdir(target, { withFileTypes: true })) {
    await cp(join(target, item.name), join(HERE, item.name), { recursive: true, force: true });
  }
  const stamp = await readStamp();
  await writeFile(STAMP_FILE, `${JSON.stringify({ ...(stamp || {}), rolledBackAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  say('✔ 已回退。回 a-Shell 重新起一次服务（↑ 回车）再刷新 Safari。');
  process.exit(0);
}

/* ── 主流程：--from ──────────────────────────────────────────────────── */
const from = value('--from');
if (!from) die('用法：node tools/update-ipad.mjs --from <新版本目录或 zip>  （更多见文件头注释）');

const dryRun = flag('--dry-run');
const { dir: srcDir, temp } = await resolveSource(resolve(from.replace(/^~(?=$|\/)/, process.env.HOME || '')));

const missing = REQUIRED.filter((p) => !existsSync(join(srcDir, p)));
if (missing.length) {
  if (temp) await rm(temp, { recursive: true, force: true });
  die(`新版本不完整，缺少：\n  ${missing.join('\n  ')}\n（多半是「文件」App 里只解压了一半，或传漏了 vendor/）`);
}

const newVersionFile = join(srcDir, 'VERSION');
const newVersion = existsSync(newVersionFile)
  ? (await readFile(newVersionFile, 'utf8')).trim().split(/\r?\n/)[0].trim()
  : (await readFile(join(srcDir, 'app', 'version.js'), 'utf8').catch(() => '')).match(/app: '([^']*)'/)?.[1] || 'unknown';

const oldStamp = await readStamp();
const oldVersion = oldStamp?.app || 'unknown';
const size = await dirSize(srcDir);

say(`来源：${srcDir === HERE ? '(当前目录)' : srcDir}`);
say(`新版本：${newVersion}   旧版本：${oldVersion}   体积：${human(size)}`);
say(`模式：${dryRun ? '只检查（--dry-run）' : '原地更新'}`);
say(`备份：.releases/${oldVersion}-${timestamp()}/（保留最近 ${KEEP_RELEASES} 份）\n`);

if (dryRun) {
  if (temp) await rm(temp, { recursive: true, force: true });
  say('✔ 检查通过：来源完整，可以真正更新（去掉 --dry-run）。');
  process.exit(0);
}
if (srcDir === HERE) die('来源就是当前目录，没有意义。请指向解压好的新版本目录。');

/* 1) 备份当前版本 */
const backup = join(RELEASES_DIR, `${oldVersion}-${timestamp()}`);
await mkdir(backup, { recursive: true });
for (const item of await readdir(HERE, { withFileTypes: true })) {
  if (item.name === '.releases' || item.name.startsWith('.update-tmp-')) continue;
  await cp(join(HERE, item.name), join(backup, item.name), { recursive: true, force: true });
}
say(`① 已备份到 .releases/${basename(backup)}/`);

/* 2) 覆盖程序文件（不删任何现存文件，用户目录里的额外文件保持原样） */
let copied = 0;
async function overlay(from, to) {
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (e.name === '.releases' || e.name.startsWith('.update-tmp-')) continue;
    const s = join(from, e.name);
    const d = join(to, e.name);
    if (e.isDirectory()) { await mkdir(d, { recursive: true }); await overlay(s, d); }
    else { await cp(s, d, { force: true }); copied++; }
  }
}
await overlay(srcDir, HERE);
say(`② 已覆盖 ${copied} 个文件`);

/* 3) 记录版本 */
await writeFile(STAMP_FILE, `${JSON.stringify({
  app: newVersion, previous: oldVersion, updatedAt: new Date().toISOString(),
  source: srcDir.replace(HERE, '.'),
}, null, 2)}\n`, 'utf8');
say(`③ 已写入 .caj-version.json`);

/* 4) 清理旧备份 */
const rel = await listReleases();
for (const name of rel.slice(KEEP_RELEASES)) {
  await rm(join(RELEASES_DIR, name), { recursive: true, force: true });
  say(`④ 清理旧备份 ${name}`);
}
if (temp) await rm(temp, { recursive: true, force: true });

say(`
✔ 更新完成：${oldVersion} → ${newVersion}

接下来（iPad / a-Shell）：
  1. 回 a-Shell，按 ↑ 上箭头调出上一条命令（python3 -m http.server 8080），回车
  2. Safari 里下拉刷新；如果是从桌面图标打开的，先划掉 App 再重开
  3. 打开「设置 → 关于」确认版本号是 ${newVersion}

出问题就回退：
  node tools/update-ipad.mjs --rollback`);
