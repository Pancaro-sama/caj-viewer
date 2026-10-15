#!/usr/bin/env node
/* ==========================================================================
 * 从 dist/ 生成 release/version.json —— 供「检查更新」与更新脚本比对。
 *
 *   node tools/make-version-json.mjs
 *
 * 版本号来自 app/version.js（由 tools/inject-version.mjs 注入）。
 * 产出的 version.json 会被 make-release.mjs 一起复制进 release/。
 * ========================================================================== */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const versionJs = join(ROOT, 'app', 'version.js');

if (!existsSync(versionJs)) {
  console.error('缺少 app/version.js，先跑 node tools/inject-version.mjs');
  process.exit(1);
}

const src = readFileSync(versionJs, 'utf8');
const grab = (key) => (src.match(new RegExp(`${key}: '([^']*)'`)) || [, ''])[1];

const info = {
  app: grab('app') || '0.0.0',
  build: grab('build'),
  commit: grab('commit'),
  channel: 'release',
  releasedAt: new Date().toISOString(),
  files: ['caj-viewer-ipad-full.zip', 'caj-viewer-ipad-lite.zip'],
};

for (const dir of ['.', 'release', 'dist']) {
  const target = dir === '.' ? ROOT : join(ROOT, dir);
  if (!existsSync(target)) continue;
  writeFileSync(join(target, 'version.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  console.log(`✔ ${dir === '.' ? 'version.json（站点根）' : `${dir}/version.json`}  app=${info.app} commit=${info.commit} build=${info.build}`);
}
