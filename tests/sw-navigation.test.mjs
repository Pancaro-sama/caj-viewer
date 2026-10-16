/**
 * Service Worker 单元测试（纯 node，不需要浏览器）。
 *
 * 覆盖的是「没有浏览器就测不到、但坏起来最致命」的那部分：
 *   · 导航策略：网络优先 / 超时回退缓存 / 网关 HTML 兜底页不冒充页面 /
 *     缓存与网络都不可用时返回明确 5xx（而不是 200 空体白屏）
 *   · 只有真正的 HTML 响应才写进缓存（网关拦截页会毒化缓存）
 *   · install 预缓存失败时不抢激活（否则缓存可能是空的）
 *
 * 跑法：node tests/sw-navigation.test.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const swPath = path.join(root, 'sw.js');

let checks = 0;
let failed = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`ok    ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}  — ${detail}`);
  }
}

/* ─────────────────────────  最小 SW 运行环境  ───────────────────────── */

class FakeCache {
  constructor(store) { this.store = store; }
  /** key 用完整 URL 字符串（含 query），与浏览器 Cache 的 URL 匹配语义一致。 */
  static keyOf(req) {
    if (typeof req === 'string') return new URL(req, 'https://app.test/').href;
    return req.url;
  }
  async match(req, opts = {}) {
    const key = FakeCache.keyOf(req);
    if (this.store.has(key)) return this.store.get(key).clone();
    if (opts.ignoreSearch) {
      const base = key.split('?')[0];
      for (const [k, v] of this.store) {
        if (k.split('?')[0] === base) return v.clone();
      }
    }
    return undefined;
  }
  async put(req, res) {
    this.store.set(FakeCache.keyOf(req), res.clone());
  }
  async addAll(files) {
    for (const f of files) {
      const key = new URL(f, 'https://app.test/').href;
      const res = await globalThis.fetch(key);
      if (!res.ok) throw new Error(`addAll 失败：${f}`);
      this.store.set(key, res.clone());
    }
  }
}

function html(body, { status = 200, type = 'text/html; charset=utf-8' } = {}) {
  return new Response(body, { status, headers: { 'content-type': type } });
}

async function loadSw({ fetchImpl, seed = {} } = {}) {
  const stores = new Map();
  const ensure = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return new FakeCache(stores.get(name));
  };
  for (const [name, entries] of Object.entries(seed)) {
    const store = stores.get(name) || new Map();
    for (const [url, res] of Object.entries(entries)) store.set(url, res);
    stores.set(name, store);
  }

  const listeners = {};
  const hooks = {};
  globalThis.__CAJ_SW_TEST_HOOKS__ = hooks;
  globalThis.caches = {
    open: async (name) => ensure(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => { stores.delete(name); return true; },
    match: async (req, opts = {}) => {
      for (const store of stores.values()) {
        const hit = await new FakeCache(store).match(req, opts);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  globalThis.self = {
    location: { origin: 'https://app.test', href: 'https://app.test/' },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    skipWaiting: async () => { globalThis.__skippedWaiting = true; },
    clients: { claim: async () => {} },
  };
  globalThis.__skippedWaiting = false;
  globalThis.fetch = fetchImpl;

  // 每次都重新求值：data: URL 加唯一 fragment 绕开模块缓存，
  // 否则第二轮拿到的还是第一轮那个已求值的模块（hooks 指向上一轮的桩）。
  const src = await readFile(swPath, 'utf8');
  installSeq += 1;
  const url = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}#${installSeq}`;
  await import(url);
  return { hooks, listeners, stores, cache: (name) => ensure(name) };
}

let installSeq = 0;

/* ─────────────────────────  用例  ───────────────────────── */

const SHELL = 'caj-viewer-v4-shell';

/** 等缓存写入（`cache.put().catch(...)` 是游离的 promise）落地。 */
const settle = () => new Promise((r) => setTimeout(r, 30));

async function main() {
  // 1) 网络正常：返回网络 HTML，并写进缓存
  {
    const { hooks, cache } = await loadSw({
      fetchImpl: async () => html('<html>v-new</html>'),
    });
    const res = await hooks.handleNavigation(new Request('https://app.test/'));
    const body = await res.text();
    await settle();
    const cached = await cache(SHELL).match('https://app.test/');
    check('导航：网络可用时返回网络上的新 HTML',
      res.status === 200 && body.includes('v-new'), `status=${res.status} body=${body}`);
    check('导航：网络响应会被写进外壳缓存（供离线使用）',
      !!cached && (await cached.text()).includes('v-new'));
  }

  // 2) 网络不可用 + 缓存里有旧版：回退缓存，不白屏
  {
    const { hooks } = await loadSw({
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
      seed: { [SHELL]: { 'https://app.test/': html('<html>v-cached</html>') } },
    });
    const res = await hooks.handleNavigation(new Request('https://app.test/'));
    const body = await res.text();
    check('导航：断网时回退到缓存里的上一个版本',
      res.status === 200 && body.includes('v-cached'), `status=${res.status} body=${body}`);
  }

  // 3) 网关返回非 HTML 的「拦截页」：不能当成页面给浏览器，要用缓存
  {
    const { hooks, cache } = await loadSw({
      fetchImpl: async () => html('{"error":"blocked"}', { type: 'application/json' }),
      seed: { [SHELL]: { 'https://app.test/': html('<html>v-cached</html>') } },
    });
    const res = await hooks.handleNavigation(new Request('https://app.test/'));
    const body = await res.text();
    check('导航：网关返回非 HTML 时不冒充页面（用缓存里的好版本）',
      body.includes('v-cached'), `status=${res.status} body=${body.slice(0, 60)}`);
    await settle();
    const cached = await cache(SHELL).match('https://app.test/');
    check('导航：非 HTML 兜底页不会被写进缓存（不毒化缓存）',
      (await cached.text()).includes('v-cached'));
  }

  // 4) 缓存与网络都不可用：必须是明确的 5xx，不能是 200 空体白屏
  {
    const { hooks } = await loadSw({
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    const res = await hooks.handleNavigation(new Request('https://app.test/'));
    const body = await res.text();
    check('导航：离线且无缓存时返回明确 5xx（不是 200 白屏）',
      res.status >= 500 && body === '', `status=${res.status} body=${body}`);
  }

  // 5) 带 query 的导航：精确匹配优先，不拿 ?v=1 的旧条目糊弄 ?v=2
  {
    const { hooks } = await loadSw({
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
      seed: {
        [SHELL]: {
          'https://app.test/?v=1': html('<html>v1</html>'),
          'https://app.test/?v=2': html('<html>v2</html>'),
        },
      },
    });
    const res = await hooks.handleNavigation(new Request('https://app.test/?v=2'));
    const body = await res.text();
    check('导航：带 query 时优先精确命中同一条缓存',
      body.includes('v2'), `body=${body}`);
  }

  // 6) install 预缓存失败：不能抢激活（否则可能带着空缓存服务用户）
  {
    const { listeners, cache } = await loadSw({
      // SHELL_FILES 大半返回失败：addAll 会抛
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/index.html') || url.endsWith('/')) return html('<html>shell</html>');
        return new Response('', { status: 500 });
      },
    });
    const event = { waitUntil: (p) => { globalThis.__installDone = p; } };
    listeners.install[0](event);
    await globalThis.__installDone;
    check('install：外壳预缓存失败时不调用 skipWaiting（保留旧版本继续服务）',
      globalThis.__skippedWaiting === false,
      `skippedWaiting=${globalThis.__skippedWaiting}`);
    const manifest = await cache(SHELL).match('https://app.test/manifest.webmanifest');
    check('install：此时外壳缓存确实残缺（所以更不能激活）',
      !manifest, `manifest=${manifest ? 'cached' : 'missing'}`);
  }

  // 7) install 预缓存成功：正常抢激活
  {
    const { listeners } = await loadSw({
      fetchImpl: async () => html('<html>shell</html>'),
    });
    const event = { waitUntil: (p) => { globalThis.__installDone2 = p; } };
    listeners.install[0](event);
    await globalThis.__installDone2;
    check('install：预缓存成功时正常 skipWaiting（发布即生效）',
      globalThis.__skippedWaiting === true);
  }

  // 8) 子资源：HTML 兜底页不能冒充脚本
  {
    const { hooks } = await loadSw({
      fetchImpl: async () => html('<html>gateway</html>'),
    });
    const req = new Request('https://app.test/app/app.js', { destination: 'script' });
    const res = await hooks.handleSubresource(req, new URL(req.url));
    const type = res.headers.get('content-type') || '';
    check('子资源：HTML 兜底页不冒充脚本（改成 text/plain 且保留状态码）',
      type.includes('text/plain'), `content-type=${type}`);
  }

  console.log(`\n检查项：${checks}   通过：${checks - failed}   失败：${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试自身抛异常：', err);
  process.exitCode = 1;
});
