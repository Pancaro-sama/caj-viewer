#!/usr/bin/env node
/* ==========================================================================
 * 一条命令出发布包：注入版本 → 打 dist → 打两个 zip → 生成 version.json。
 *
 *   node tools/release.mjs
 *
 * 和 make-release.mjs 的区别：本脚本会先把 VERSION 里的版本号与 git 提交注入
 * app/version.js，并额外产出 version.json（供「检查更新」和更新脚本比对）。
 * ========================================================================== */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = process.execPath;

const run = (args, label) => {
  process.stdout.write(`\n▶ ${label}\n`);
  execFileSync(node, args, { cwd: ROOT, stdio: 'inherit' });
};

const readVersionFile = () => readFileSync(join(ROOT, 'VERSION'), 'utf8').trim().split(/\r?\n/)[0].trim();

run(['tools/inject-version.mjs', '--channel=release'], '注入版本信息');
run(['tools/make-release.mjs'], '打包 dist 与两个 zip');
run(['tools/make-version-json.mjs'], '生成 version.json');

console.log(`
────────────────────────────────────────
发布完成：v${readVersionFile()}
  release/caj-viewer-ipad-full.zip
  release/caj-viewer-ipad-lite.zip
  release/SHA256SUMS.txt
  release/version.json

更新已部署的 iPad：
  · 静态托管路线 → 把 dist/ 重新上传覆盖即可（_headers 已给外壳设 no-cache）
  · a-Shell 路线  → 把新 zip 发到 iPad，跑 node tools/update-ipad.mjs --from <zip>
────────────────────────────────────────`);
