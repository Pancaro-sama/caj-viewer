/**
 * 自检判定的单元测试（纯 node）。这里覆盖三类「只在特定文档上才现形」的假信号：
 *
 *   1. 扫描件 / 纯图页没有任何文字 → 不许报「文本层丢了」（假红字）
 *   2. 一页瞬时失败（worker 忙、页面 cleanup）→ 不许把这一页永久当成无文字（假阴性）
 *   3. 全缺 / 部分缺必须是两种不同的故障码（text-layer-empty vs text-layer-partial）
 *
 * 被测函数直接从 app/app.js 抽取：extract + 求值，而不是抄一份逻辑，
 * 保证测试跟着实现一起变。
 *
 * 跑法：node tests/selfcheck-logic.test.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const src = await readFile(path.join(root, 'app', 'app.js'), 'utf8');

/** 从 app.js 里抽出命名函数（从 `function name(` 到下一个顶层 `function`/结尾）。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js 里找不到函数 ${name}`);
  const next = source.indexOf('\nfunction ', start + 1);
  const chunk = source.slice(start, next < 0 ? source.length : next);
  return chunk.trim();
}

const summarizeTextLayers = new Function(
  `${extractFunction(src, 'summarizeTextLayers')}\nreturn summarizeTextLayers;`,
)();
const textLayerIssueFrom = new Function(
  `${extractFunction(src, 'textLayerIssueFrom')}\nreturn textLayerIssueFrom;`,
)();

let checks = 0;
let failed = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`ok    ${name}${detail ? `  — ${detail}` : ''}`);
  else { failed += 1; console.log(`FAIL  ${name}  — ${detail}`); }
}

/* ─────────────────────────  1. 汇总  ───────────────────────── */

check('扫描件：几页全是纯图 → 不报任何文本层问题',
  textLayerIssueFrom(summarizeTextLayers([
    { hasLayer: false, hasText: false },
    { hasLayer: false, hasText: false },
  ])) === null,
  JSON.stringify(summarizeTextLayers([{ hasLayer: false, hasText: false }, { hasLayer: false, hasText: false }])));

check('健康文档：有文字且都建出了文本层 → 不报问题',
  textLayerIssueFrom(summarizeTextLayers([
    { hasLayer: true, hasText: true },
    { hasLayer: true, hasText: true },
    { hasLayer: false, hasText: false },
  ])) === null);

{
  const s = summarizeTextLayers([
    { hasLayer: true, hasText: true },
    { hasLayer: false, hasText: true },
  ]);
  const issue = textLayerIssueFrom(s);
  check('部分页丢文本层 → code=text-layer-partial、数量=1 页',
    issue && issue.code === 'text-layer-partial' && issue.count === 1,
    JSON.stringify({ s, issue }));
}

{
  const s = summarizeTextLayers([
    { hasLayer: false, hasText: true },
    { hasLayer: false, hasText: true },
    { hasLayer: false, hasText: false },
  ]);
  const issue = textLayerIssueFrom(s);
  check('全部有文字的页都丢了文本层 → code=text-layer-empty',
    issue && issue.code === 'text-layer-empty' && issue.count === 2,
    JSON.stringify({ s, issue }));
  check('异常项都带 auto=true（否则一键修复不会认领）',
    !!issue && issue.auto === true);
  check('文案里带上页数（用户能判断严重程度）',
    !!issue && issue.label.includes('2 页'), issue && issue.label);
}

/* ─────────────────────────  2. pageTextItems 的失败不落缓存  ───────────────────────── */

{
  // 用最小桩件测「catch 之后不缓存 []」这条约定：从 app.js 里抽 pageTextItems 的源码，
  // 逐条断言它没有把 [] 写进 p.textItems。
  const body = extractFunction(src, 'pageTextItems');
  check('pageTextItems：失败分支不会把 [] 写进 p.textItems（一次瞬时失败不再永久漏报）',
    !/p\.textItems\s*=\s*\[\]/.test(body) && /p\.textItemsPromise\s*=\s*null/.test(body),
    body.replace(/\s+/g, ' ').slice(0, 160));
}

/* ─────────────────────────  3. 自检的并发与消抖  ───────────────────────── */

{
  const detect = src.slice(src.indexOf('async function detectRuntimeIssues'), src.indexOf('async function detectRuntimeIssues') + 2600);
  check('自检并发受控（mapLimit，而不是顺序 await 卡住扫描件）',
    /mapLimit\(rendered,\s*4/.test(detect));
  check('自检只统计「渲染真正完成」的页（排除 renderTask / textLayerPending）',
    /p\.rendered\s*&&\s*!p\.renderTask\s*&&\s*!p\.textLayerPending/.test(detect));
}

console.log(`\n检查项：${checks}   通过：${checks - failed}   失败：${failed}`);
if (failed) process.exitCode = 1;
