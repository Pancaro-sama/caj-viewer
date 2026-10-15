#!/usr/bin/env node
/* ==========================================================================
 * app/pinch-math.js 的纯逻辑自测 —— 零依赖，直接 `node tests/pinch-math.test.mjs`
 *
 * 覆盖 AR-2.0 要求的四条：
 *   1. 焦点不动（预览期 transform 与抬手后布局两种状态）；
 *   2. 恒等：k = 1 且焦点未动时 scrollNew 逐位等于 scroll0；
 *   3. 极点：撞到 ZOOM_MIN / ZOOM_MAX 时仍满足焦点不动；
 *   4. 单指移动（k = 1）时内容跟手平移。
 * ========================================================================== */

import {
  previewRatio,
  previewTransform,
  scrollAfterPinch,
  focusDocPoint,
  projectPreview,
  projectLayout,
  clampScale,
} from '../app/pinch-math.js';

const SCALE_PER_PERCENT = 1 / 75;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 8;
const EPS = 0.01;

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(name + (detail ? '  [' + detail + ']' : ''));
}

function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps === undefined ? EPS : eps);
}

/* 确定性 PRNG（mulberry32）：每次运行产生同一组随机数。 */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20240918);
const range = (lo, hi) => lo + rand() * (hi - lo);

/* ── 1. 恒等：k = 1，焦点没动 ─────────────────────────────── */
for (let i = 0; i < 200; i++) {
  const scroll0 = { left: range(0, 4000), top: range(0, 20000) };
  const f0 = { x: range(0, 820), y: range(0, 1180) };
  const s = scrollAfterPinch(scroll0, f0, { x: f0.x, y: f0.y }, 1);
  check(
    '恒等 k=1, focus 未动 -> scrollNew === scroll0',
    s.left === scroll0.left && s.top === scroll0.top,
    'left ' + s.left + ' vs ' + scroll0.left,
  );
}

/* ── 2. 预览期：起始焦点下的文档点必须贴在当前焦点下 ───────── */
for (let i = 0; i < 400; i++) {
  const scroll = { left: range(0, 4000), top: range(0, 20000) };
  const f0 = { x: range(0, 820), y: range(0, 1180) };
  const k = Math.exp(range(Math.log(0.2), Math.log(6)));
  const f = { x: range(0, 820), y: range(0, 1180) };
  const t = previewTransform(scroll, f0, f, k);
  const D = focusDocPoint(scroll, f0);
  const p = projectPreview(t, k, D, scroll);
  check(
    '预览期焦点不动',
    approx(p.x, f.x) && approx(p.y, f.y),
    'k=' + k.toFixed(4) + ' p=(' + p.x.toFixed(3) + ',' + p.y.toFixed(3) +
      ') f=(' + f.x.toFixed(3) + ',' + f.y.toFixed(3) + ')',
  );
}

/* ── 3. 抬手后：新布局下焦点下的文档点不动 ──────────────────── */
for (let i = 0; i < 400; i++) {
  const scroll0 = { left: range(0, 4000), top: range(0, 20000) };
  const f0 = { x: range(0, 820), y: range(0, 1180) };
  const f = { x: range(0, 820), y: range(0, 1180) };
  const scale0 = range(0.2, 4);
  const raw = Math.exp(range(Math.log(0.05), Math.log(12)));
  const k = previewRatio(raw, scale0, ZOOM_MIN, ZOOM_MAX);
  const target = clampScale(scale0 * k, ZOOM_MIN, ZOOM_MAX);
  const kEff = target / scale0; // 真正落地的比例
  const D = focusDocPoint(scroll0, f0);
  const scrollNew = scrollAfterPinch(scroll0, f0, f, kEff);
  const p = projectLayout(kEff, D, scrollNew);
  check(
    '抬手后焦点下的文档点不动',
    approx(p.x, f.x) && approx(p.y, f.y),
    'kEff=' + kEff.toFixed(5) + ' dx=' + (p.x - f.x).toFixed(6),
  );
  check('previewRatio 把落地比例夹进 [MIN,MAX]',
    target >= ZOOM_MIN - 1e-12 && target <= ZOOM_MAX + 1e-12,
    'target=' + target);
}

/* ── 4. 极点：撞 ZOOM_MIN / ZOOM_MAX ──────────────────────── */
const poles = [
  { raw: 1e6, scale0: 1, expect: ZOOM_MAX },
  { raw: 1e-6, scale0: 1, expect: ZOOM_MIN },
  { raw: 1e6, scale0: 3.2, expect: ZOOM_MAX },
  { raw: 1e-6, scale0: 3.2, expect: ZOOM_MIN },
];
for (const pole of poles) {
  const k = previewRatio(pole.raw, pole.scale0, ZOOM_MIN, ZOOM_MAX);
  const target = clampScale(pole.scale0 * k, ZOOM_MIN, ZOOM_MAX);
  check('极点夹取 -> ' + pole.expect,
    approx(target, pole.expect, 1e-9), 'target=' + target);

  const scroll0 = { left: 1200, top: 8000 };
  const f0 = { x: 300, y: 500 };
  const f = { x: 410, y: 640 };
  const kEff = target / pole.scale0;
  const D = focusDocPoint(scroll0, f0);
  const p = projectLayout(kEff, D, scrollAfterPinch(scroll0, f0, f, kEff));
  check('极点处焦点不动', approx(p.x, f.x) && approx(p.y, f.y),
    'kEff=' + kEff + ' p=(' + p.x + ',' + p.y + ')');
}

/* ── 5. k = 1 且手指移动：内容跟手，焦点下的点仍不动 ────────── */
for (let i = 0; i < 100; i++) {
  const scroll0 = { left: range(0, 3000), top: range(0, 15000) };
  const f0 = { x: range(0, 700), y: range(0, 1000) };
  const f = { x: range(0, 700), y: range(0, 1000) };
  const scrollNew = scrollAfterPinch(scroll0, f0, f, 1);
  check('k=1 平移量 = focus0 - focus',
    approx(scrollNew.left, scroll0.left + (f0.x - f.x), 1e-9) &&
    approx(scrollNew.top, scroll0.top + (f0.y - f.y), 1e-9));
  const D = focusDocPoint(scroll0, f0);
  const p = projectLayout(1, D, scrollNew);
  check('k=1 平移后焦点不动', approx(p.x, f.x) && approx(p.y, f.y));
}

/* ── 6. 非法输入回落到 1；k=1 落在合法区间 ─────────────────── */
for (const bad of [NaN, 0, -3, Infinity, -Infinity]) {
  check('previewRatio 非法输入 ' + String(bad) + ' -> 1',
    previewRatio(bad, 1, ZOOM_MIN, ZOOM_MAX) === 1);
}
check('previewRatio(1) === 1', previewRatio(1, 1, ZOOM_MIN, ZOOM_MAX) === 1);
check('previewRatio(1) 在 scale0=3.2 时 === 1',
  previewRatio(1, 3.2, ZOOM_MIN, ZOOM_MAX) === 1);
check('SCALE_PER_PERCENT 是正数', SCALE_PER_PERCENT > 0);

/* ── 汇总 ─────────────────────────────────────────────────── */
const total = passed + failures.length;
if (failures.length === 0) {
  console.log('pinch-math: ' + total + '/' + total + ' 断言通过');
  console.log('  - 恒等 / 预览焦点不动 / 抬手焦点不动 / 缩放极点 / 平移 / 非法输入：全部 OK');
} else {
  console.error('pinch-math: ' + passed + '/' + total + ' 断言通过，失败 ' + failures.length + ' 项：');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
