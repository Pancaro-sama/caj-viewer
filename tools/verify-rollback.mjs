// 验证线上回退：站点根应为稳定版 91dc1d8，/experimental/ 应为 v4 实验版。
// 用法：node --use-system-ca tools/verify-rollback.mjs [--wait]
const BASE = 'https://pancaro-sama.github.io/caj-viewer';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function getText(path) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}cb=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  const text = await res.text();
  return { res, text, url };
}

async function getHead(path) {
  const url = `${BASE}${path}?cb=${Date.now()}`;
  const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  return { res, url };
}

function versionCommit(text) {
  const m = text.match(/commit:\s*'([^']+)'/);
  return m ? m[1] : null;
}

async function snapshot() {
  const rootHtml = await getText('/index.html');
  const rootApp = await getText('/app/app.js');
  const rootSw = await getText('/sw.js');
  const rootVersion = await getText('/app/version.js');
  const expHtml = await getText('/experimental/index.html');
  const expSw = await getText('/experimental/sw.js');
  const expDoc = await getText('/experimental/EXPERIMENTAL.md');

  console.log(`BASE ${BASE}`);
  console.log(`root index.html   ${rootHtml.res.status}  ${rootHtml.res.headers.get('content-type')}`);
  console.log(`root app/app.js   ${rootApp.res.status}  ${rootApp.res.headers.get('content-type')}  ${rootApp.text.length} bytes`);
  console.log(`root sw.js        ${rootSw.res.status}  ${rootSw.res.headers.get('content-type')}`);
  console.log(`exp  index.html   ${expHtml.res.status}  ${expHtml.res.headers.get('content-type')}`);
  console.log(`exp  EXPERIMENTAL ${expDoc.res.status}  ${expDoc.res.headers.get('content-type')}`);
  console.log('');

  // ---- 稳定版：站点根 ----
  const swVer = (rootSw.text.match(/const VERSION = '([^']+)'/) || [])[1];
  check('稳定版 sw.js 版本 = caj-viewer-v3', swVer === 'caj-viewer-v3', `实际 ${swVer}`);
  // 注意：这一行在 91dc1d8 基线里就存在（export-auditor 的 N2），回退后自然带回来。
  // 这里只做「记录」不做「断言通过/失败」，避免把「已回退到基线」误判成回退失败。
  const n2Present = /if \(res && !isHtmlResponse\(res\)\) return res;/.test(rootSw.text);
  console.log(`NOTE  稳定版 sw.js ${n2Present ? '仍含' : '不含'} 基线里的 N2 行（HTML 分流短路）`);
  check('稳定版 app.js 不含 v4 的 summarizeTextLayers', !/summarizeTextLayers/.test(rootApp.text));
  const appCommit = versionCommit(rootVersion.text);
  check("稳定版 app/version.js commit = 'c61e238'", appCommit === 'c61e238', `实际 ${appCommit}`);
  check('稳定版 index.html 不带实验横幅', !/expBanner/.test(rootHtml.text));
  check('稳定版 index.html 仍带 manifest 链接', /rel="manifest"/.test(rootHtml.text));

  // 稳定版关键资源在线
  for (const p of ['/vendor/pdfjs/pdf_viewer.css', '/app/style.css', '/app/settings.js']) {
    const h = await getHead(p);
    check(`稳定版资源 ${p} 可达`, h.res.ok, `HTTP ${h.res.status} ${h.res.headers.get('content-type') || ''}`);
  }

  // ---- 实验版：/experimental/ ----
  check('实验版 index.html 带实验横幅', /id="expBanner"/.test(expHtml.text));
  check('实验版 index.html 有回稳定版链接', /href="\.\.\/"/.test(expHtml.text));
  check('实验版 index.html 去掉了 manifest', !/rel="manifest"/.test(expHtml.text));
  check('实验版 app.js 含 v4 的 summarizeTextLayers', /summarizeTextLayers/.test((await getText('/experimental/app/app.js')).text));
  const expSwVer = (expSw.text.match(/const VERSION = '([^']+)'/) || [])[1];
  check('实验版 sw.js 版本 = caj-viewer-v4', expSwVer === 'caj-viewer-v4', `实际 ${expSwVer}`);
  check('实验版 EXPERIMENTAL.md 可读', expDoc.res.ok && /实验版/.test(expDoc.text), `HTTP ${expDoc.res.status}`);
  for (const p of ['/experimental/vendor/pdfjs/pdf_viewer.css', '/experimental/app/style.css', '/experimental/app/app.js']) {
    const h = await getHead(p);
    check(`实验版资源 ${p} 可达`, h.res.ok, `HTTP ${h.res.status} ${h.res.headers.get('content-type') || ''}`);
  }
  check('实验版目录本身可直接访问', (await getText('/experimental/')).res.ok);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nchecks: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
  return failed.length === 0;
}

const wait = process.argv.includes('--wait');
let ok = false;
for (let i = 0; i < (wait ? 20 : 1); i++) {
  if (i) {
    console.log(`\n--- 等待 Pages 重新部署后重试 (${i}/19, 20s) ---\n`);
    await new Promise((r) => setTimeout(r, 20000));
  }
  results.length = 0;
  ok = await snapshot();
  if (ok) break;
}
process.exit(ok ? 0 : 1);
