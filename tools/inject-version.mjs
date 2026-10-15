#!/usr/bin/env node
/* ==========================================================================
 * 生成 app/version.js —— 版本信息的唯一注入点。
 *
 *   node tools/inject-version.mjs [--channel=local|dist|release]
 *
 * 版本号来自仓库根目录的 VERSION（一行，例如 2.0.0）。
 * 每次打包前都会自动跑一次，所以 dist / zip 里的版本信息一定是当次构建的。
 * ========================================================================== */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VERSION_FILE = join(ROOT, 'VERSION');
const OUTPUT = join(ROOT, 'app', 'version.js');

const channelArg = process.argv.find((a) => a.startsWith('--channel='));
const channel = channelArg ? channelArg.split('=')[1] : 'local';
const commitArg = process.argv.find((a) => a.startsWith('--commit='));
const commitOverride = commitArg ? commitArg.split('=')[1] : '';

function readVersion() {
  if (!existsSync(VERSION_FILE)) return '0.0.0';
  const raw = readFileSync(VERSION_FILE, 'utf8').trim().split(/\r?\n/)[0].trim();
  return raw || '0.0.0';
}

/** 直接读 .git/HEAD —— 不 spawn 进程，因此在任何沙箱里都能用。 */
function commitFromGitDir() {
  try {
    const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const ref = join(ROOT, '.git', head.slice(4).trim());
      return readFileSync(ref, 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return '';
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return '';
  }
}

const app = readVersion();
const commitHash = commitOverride || git(['rev-parse', '--short', 'HEAD']) || commitFromGitDir();
const dirty = commitHash ? git(['status', '--porcelain']).length > 0 : false;
const commit = dirty ? `${commitHash}-dirty` : commitHash;
const build = new Date().toISOString();

const content = `/* ==========================================================================
 * 版本信息（由 tools/inject-version.mjs 生成，不要手改这个文件）。
 *
 * 改版本号请改仓库根目录的 VERSION 文件，然后：
 *   node tools/inject-version.mjs
 * 打包（make-dist / make-release）会自动重新生成一次。
 * ========================================================================== */

export const VERSION = Object.freeze({
  app: '${app}',
  build: '${build}',
  commit: '${commit}',
  channel: '${channel}',
});

export default VERSION;
`;

writeFileSync(OUTPUT, content, 'utf8');
console.log(`app/version.js ← app=${app} channel=${channel} commit=${commit || '(无 git)'} build=${build}`);
