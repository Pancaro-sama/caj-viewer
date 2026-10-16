/* ==========================================================================
 * CAJ 阅读器 — 设置面板
 *
 * 目标（用户 m00948 第 2 条）：把主题、阅读、文件、自诊断、关于集中到一个
 * 触控友好的面板里。本文件是设置的**唯一实现**；挂载容器
 * `#settingsOverlay` 由 index.html 提供（本文件不碰 index.html）。
 *
 * 契约见 docs/dev/AR-2.0.md「app/settings.js（settings-smith）」：
 *   export function installSettings({ app, overlayEl }) -> { open, close, isOpen, refresh }
 *
 * `app` 门面只读使用。AR 里没有的 setter（主题/反色/侧栏默认值、页面间距、
 * 滚动方式、清空最近文件、更新地址）一律用「存在才调用」的方式处理，并把
 * 需要的 hook 名写进 task 回报，由 lead 落地 —— 本文件不改 app.js。
 *
 * iPad Safari 15+ 语法约束：不用 ??= / ||= / structuredClone / toSorted。
 * ========================================================================== */

/** 面板自身新增项（页面间距、滚动方式）的持久化键；不污染 app.js 的 settings 键。 */
const PREF_KEY = 'cajviewer.settings.panel';
/** app.js 的主题/侧栏默认值持久化键（仅在缺少门面 setter 时兜底读写）。 */
const APP_SETTINGS_KEY = 'cajviewer.settings';
/** 与 app.js 的 SCALE_PER_PERCENT 保持一致；门面若暴露则优先用门面的。 */
const FALLBACK_SCALE_PER_PERCENT = 1 / 75;
const SCALE_MIN_PERCENT = 15;
const SCALE_MAX_PERCENT = 800;

const SECTIONS = [
  ['appearance', '外观'],
  ['reading', '阅读'],
  ['files', '文件'],
  ['diagnostics', '诊断'],
  ['about', '关于'],
];

const PAGE_GAPS = [0, 8, 16, 28];

const PANEL_HTML = `
<div class="settings-panel" id="settingsPanel" role="dialog" aria-modal="true" aria-label="设置">
  <header class="settings-head">
    <h2 class="settings-title">设置</h2>
    <button type="button" class="settings-close" id="settingsClose" aria-label="关闭设置">✕</button>
  </header>

  <nav class="settings-tabs" id="settingsTabs" role="tablist" aria-label="设置分区"></nav>

  <div class="settings-body" id="settingsBody">
    <section class="settings-section" data-set-panel="appearance" role="tabpanel" aria-label="外观">
      <div class="settings-row">
        <div class="settings-label">
          <span>主题</span>
          <small>跟随系统，或固定浅色 / 深色</small>
        </div>
        <div class="settings-seg" id="setThemeSeg" role="group" aria-label="主题">
          <button type="button" class="settings-seg-btn" data-value="auto">自动</button>
          <button type="button" class="settings-seg-btn" data-value="light">浅色</button>
          <button type="button" class="settings-seg-btn" data-value="dark">深色</button>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <span>页面反色</span>
          <small>夜间读 PDF：白底变黑底，不改动原文件</small>
        </div>
        <button type="button" class="settings-switch" id="setInvert" role="switch" aria-checked="false">
          <span class="settings-switch-knob"></span>
        </button>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <span>缩略图侧栏默认展开</span>
          <small>下次启动时自动展开侧栏（宽屏 / iPad 横屏）</small>
        </div>
        <button type="button" class="settings-switch" id="setSidebar" role="switch" aria-checked="false">
          <span class="settings-switch-knob"></span>
        </button>
      </div>
    </section>

    <section class="settings-section" data-set-panel="reading" role="tabpanel" aria-label="阅读" hidden>
      <div class="settings-row">
        <div class="settings-label">
          <span>缩放方式</span>
          <small>适应宽度 / 适应整页 / 自定义比例</small>
        </div>
        <div class="settings-seg" id="setFitSeg" role="group" aria-label="缩放方式">
          <button type="button" class="settings-seg-btn" data-value="width">适应宽度</button>
          <button type="button" class="settings-seg-btn" data-value="page">适应整页</button>
          <button type="button" class="settings-seg-btn" data-value="custom">自定义</button>
        </div>
      </div>

      <div class="settings-row settings-row-stack">
        <div class="settings-label">
          <span>自定义比例</span>
          <small>${SCALE_MIN_PERCENT}% – ${SCALE_MAX_PERCENT}%</small>
        </div>
        <div class="settings-range-wrap">
          <input type="range" id="setScaleRange" class="settings-range"
                 min="${SCALE_MIN_PERCENT}" max="${SCALE_MAX_PERCENT}" step="5" value="100"
                 aria-label="自定义比例" />
          <output id="setScaleValue" class="settings-value" for="setScaleRange">100%</output>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <span>旋转</span>
          <small>每次顺时针旋转 90°</small>
        </div>
        <button type="button" class="settings-btn" id="setRotate">
          旋转 <span id="setRotateValue">0°</span>
        </button>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <span>页面间距</span>
          <small>连续滚动时页面之间的留白</small>
        </div>
        <select class="settings-select" id="setPageGap" aria-label="页面间距">
          <option value="0">无间隙</option>
          <option value="8">小</option>
          <option value="16">中</option>
          <option value="28">大</option>
        </select>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <span>滚动方式</span>
          <small>连续滚动，或一次一页</small>
        </div>
        <div class="settings-seg" id="setScrollSeg" role="group" aria-label="滚动方式">
          <button type="button" class="settings-seg-btn" data-value="continuous">连续</button>
          <button type="button" class="settings-seg-btn" data-value="single">单页</button>
        </div>
      </div>
    </section>

    <section class="settings-section" data-set-panel="files" role="tabpanel" aria-label="文件" hidden>
      <div class="settings-row settings-row-stack">
        <div class="settings-label">
          <span>当前文档</span>
          <small>在已经打开的文件之间切换</small>
        </div>
        <div id="setDocList" class="settings-doc-list"></div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <span>关闭当前文档</span>
          <small>释放当前文档占用的内存</small>
        </div>
        <button type="button" class="settings-btn" id="setCloseDoc">关闭</button>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <span>清空最近文件</span>
          <small>删除本机保存的文件索引与缓存副本</small>
        </div>
        <button type="button" class="settings-btn settings-btn-danger" id="setClearRecent">清空</button>
      </div>

      <div class="settings-row" id="setCacheRow" hidden>
        <div class="settings-label">
          <span>已用缓存</span>
          <small>本应用在本机占用的存储空间</small>
        </div>
        <span id="setCacheSize" class="settings-value">—</span>
      </div>
    </section>

    <section class="settings-section" data-set-panel="diagnostics" role="tabpanel" aria-label="诊断" hidden>
      <div class="settings-diag-head">
        <div class="settings-label">
          <span>环境自检</span>
          <small id="setDiagStatus">打开诊断分区时自动检测</small>
        </div>
        <button type="button" class="settings-btn" id="setDiagRun">重新检测</button>
      </div>

      <div id="setDiagTableWrap" class="settings-diag-wrap">
        <p class="settings-muted">尚未检测。</p>
      </div>

      <div id="setDiagTips" class="settings-tips"></div>

      <div class="settings-row">
        <div class="settings-label">
          <span>自动修复显示异常</span>
          <small>打开/切换文档后自动修掉文本层与缩放异常，不用手动点</small>
        </div>
        <button type="button" class="settings-btn is-on" id="setAutoHeal"
                aria-pressed="true" role="switch">已开启</button>
      </div>

      <div class="settings-actions">
        <button type="button" class="settings-btn settings-btn-primary" id="setRepair">一键修复</button>
        <button type="button" class="settings-btn" id="setWarmCache">预热离线包</button>
        <button type="button" class="settings-btn" id="setExportDiag">导出诊断报告</button>
        <button type="button" class="settings-btn" id="setShowDiag">完整诊断面板</button>
      </div>
    </section>

    <section class="settings-section" data-set-panel="about" role="tabpanel" aria-label="关于" hidden>
      <div class="settings-about-head">
        <div class="settings-about-name" id="setVersionName">CAJ 阅读器</div>
        <div class="settings-about-sub" id="setVersionMeta">—</div>
      </div>

      <dl class="settings-kv">
        <div><dt>版本</dt><dd id="setVersionApp">—</dd></div>
        <div><dt>构建</dt><dd id="setVersionBuild">—</dd></div>
        <div><dt>提交</dt><dd id="setVersionCommit">—</dd></div>
      </dl>

      <div class="settings-update" id="setUpdateBox"></div>
    </section>
  </div>
</div>`;

/* ─────────────────────────  小工具  ───────────────────────── */

function loadPrefs() {
  const fallback = { scrollMode: 'continuous', pageGap: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    const gap = PAGE_GAPS.indexOf(Number(raw.pageGap)) >= 0 ? Number(raw.pageGap) : fallback.pageGap;
    const mode = raw.scrollMode === 'single' ? 'single' : 'continuous';
    return { scrollMode: mode, pageGap: gap };
  } catch {
    return fallback;
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function shortCommit(commit) {
  const s = String(commit || '').trim();
  return s ? s.slice(0, 8) : '';
}

/**
 * 把设置面板当作独立模块装到 overlayEl 上。
 *
 * @param {{ app: object, overlayEl: HTMLElement }} options
 * @returns {{ open: (section?: string) => void, close: () => void, isOpen: () => boolean, refresh: () => void }}
 */
export function installSettings({ app, overlayEl } = {}) {
  if (!app) throw new Error('installSettings: 缺少 app 门面对象');
  if (!overlayEl) throw new Error('installSettings: 缺少 overlayEl（#settingsOverlay）');

  const prefs = loadPrefs();
  let currentSection = 'appearance';
  let diagRows = null;
  let diagTips = null;
  let diagBusy = false;
  let scaleDragging = false;
  let lastFocused = null;

  overlayEl.classList.add('settings-overlay');
  overlayEl.innerHTML = PANEL_HTML;

  const q = (sel) => overlayEl.querySelector(sel);
  const qa = (sel) => Array.prototype.slice.call(overlayEl.querySelectorAll(sel));

  const tabsEl = q('#settingsTabs');
  const bodyEl = q('#settingsBody');
  const closeBtn = q('#settingsClose');

  const themeSeg = q('#setThemeSeg');
  const invertBtn = q('#setInvert');
  const sidebarBtn = q('#setSidebar');

  const fitSeg = q('#setFitSeg');
  const scaleRange = q('#setScaleRange');
  const scaleValue = q('#setScaleValue');
  const rotateBtn = q('#setRotate');
  const rotateValue = q('#setRotateValue');
  const pageGapSel = q('#setPageGap');
  const scrollSeg = q('#setScrollSeg');

  const docListEl = q('#setDocList');
  const closeDocBtn = q('#setCloseDoc');
  const clearRecentBtn = q('#setClearRecent');
  const cacheRow = q('#setCacheRow');
  const cacheSizeEl = q('#setCacheSize');

  const diagStatus = q('#setDiagStatus');
  const diagTableWrap = q('#setDiagTableWrap');
  const diagTipsEl = q('#setDiagTips');
  const diagRunBtn = q('#setDiagRun');
  const repairBtn = q('#setRepair');
  const autoHealBtn = q('#setAutoHeal');
  const warmCacheBtn = q('#setWarmCache');
  const exportDiagBtn = q('#setExportDiag');
  const showDiagBtn = q('#setShowDiag');

  const versionName = q('#setVersionName');
  const versionMeta = q('#setVersionMeta');
  const versionApp = q('#setVersionApp');
  const versionBuild = q('#setVersionBuild');
  const versionCommit = q('#setVersionCommit');
  const updateBox = q('#setUpdateBox');

  /* ── 分段控件 ── */

  function segButtons(container) {
    return Array.prototype.slice.call(container.querySelectorAll('.settings-seg-btn'));
  }
  function setSeg(container, value) {
    segButtons(container).forEach((btn) => {
      const on = btn.dataset.value === value;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setSwitch(btn, on) {
    btn.classList.toggle('is-on', !!on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /* ── 门面读取 ── */

  function state() {
    return app.state || {};
  }

  function scalePerPercent() {
    const v = Number(app.SCALE_PER_PERCENT);
    return Number.isFinite(v) && v > 0 ? v : FALLBACK_SCALE_PER_PERCENT;
  }

  function currentScale() {
    const s = state();
    const page = s.pages && s.pages[s.current - 1];
    const scale = (page && page.scale) || s.customScale || 1;
    return scale;
  }

  function currentPercent() {
    const pct = currentScale() / scalePerPercent();
    return Math.max(SCALE_MIN_PERCENT, Math.min(SCALE_MAX_PERCENT, Math.round(pct)));
  }

  /** 主题/反色/侧栏默认值的当前值：门面优先，其次读 app.js 的持久化设置。 */
  function readAppSettings() {
    try {
      return JSON.parse(localStorage.getItem(APP_SETTINGS_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function themeValue() {
    const s = state();
    if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'auto') return s.theme;
    return readAppSettings().theme || 'auto';
  }

  function sidebarDefault() {
    if (typeof app.getSidebarDefault === 'function') return !!app.getSidebarDefault();
    const stored = readAppSettings();
    if (typeof stored.sidebar === 'boolean') return stored.sidebar;
    return !!state().sidebar;
  }

  /* ── 主题 / 反色 / 侧栏 ── */

  function setTheme(mode) {
    if (typeof app.setTheme === 'function') {
      app.setTheme(mode);
    } else {
      // 兜底：门面还没提供 setTheme 时，直接改 app.state 并走 app 自己的应用/持久化。
      const s = state();
      s.theme = mode;
      if (typeof app.applyTheme === 'function') app.applyTheme();
      if (typeof app.saveSettings === 'function') app.saveSettings();
    }
    setSeg(themeSeg, mode);
  }

  function setInvert(on) {
    if (typeof app.setInvert === 'function') {
      app.setInvert(!!on);
    } else {
      const s = state();
      s.invert = !!on;
      const viewer = document.querySelector('#viewer');
      if (viewer) viewer.classList.toggle('invert-pages', !!on);
      if (typeof app.saveSettings === 'function') app.saveSettings();
    }
    setSwitch(invertBtn, on);
  }

  function setSidebarDefault(on) {
    if (typeof app.setSidebarDefault === 'function') {
      app.setSidebarDefault(!!on);
    } else {
      const merged = readAppSettings();
      merged.sidebar = !!on;
      try { localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(merged)); } catch { /* 隐私模式忽略 */ }
    }
    setSwitch(sidebarBtn, on);
  }

  /* ── 阅读 ── */

  function applyFit(mode) {
    setSeg(fitSeg, mode);
    if (typeof app.setFit === 'function') app.setFit(mode);
  }

  function applyScalePercent(percent, userInitiated) {
    const pct = Math.max(SCALE_MIN_PERCENT, Math.min(SCALE_MAX_PERCENT, Number(percent) || 100));
    const scale = pct * scalePerPercent();
    if (typeof app.zoomTo === 'function') app.zoomTo(scale);
    if (userInitiated) setSeg(fitSeg, 'custom');
  }

  function applyRotation() {
    if (typeof app.rotate === 'function') app.rotate();
    if (typeof app.invalidateThumbnails === 'function') app.invalidateThumbnails();
    // 立即刷新读数：app.js 的 onRotate 可能异步触发 refresh()，面板不能等。
    rotateValue.textContent = `${Number(state().rotation) || 0}°`;
  }

  function applyPageGap(px) {
    const gap = PAGE_GAPS.indexOf(Number(px)) >= 0 ? Number(px) : 16;
    prefs.pageGap = gap;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 忽略 */ }
    // 门面 hook 存在时交给 app.js；不存在时用根 CSS 变量兜底（等 lead 接线）。
    if (typeof app.setPageGap === 'function') app.setPageGap(gap);
    document.documentElement.style.setProperty('--page-gap', `${gap}px`);
    pageGapSel.value = String(gap);
  }

  function applyScrollMode(mode) {
    const value = mode === 'single' ? 'single' : 'continuous';
    prefs.scrollMode = value;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 忽略 */ }
    if (typeof app.setScrollMode === 'function') app.setScrollMode(value);
    document.documentElement.dataset.scrollMode = value;
    setSeg(scrollSeg, value);
  }

  /* ── 文件 ── */

  function docManager() {
    return app.docs && typeof app.docs.list === 'function' ? app.docs : null;
  }

  function renderDocList() {
    docListEl.textContent = '';
    const docs = docManager();
    if (!docs) {
      const p = document.createElement('p');
      p.className = 'settings-muted';
      p.textContent = '暂不可用';
      docListEl.append(p);
      return;
    }
    let list = [];
    try { list = docs.list() || []; } catch { list = []; }
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'settings-muted';
      p.textContent = '还没有打开任何文件。';
      docListEl.append(p);
      return;
    }
    list.forEach((doc) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `settings-doc${doc.active ? ' is-on' : ''}`;
      item.dataset.id = doc.id;
      item.title = doc.fileName || doc.id;

      const name = document.createElement('span');
      name.className = 'settings-doc-name';
      name.textContent = doc.fileName || '未命名文档';

      const meta = document.createElement('span');
      meta.className = 'settings-doc-meta';
      const bits = [];
      if (doc.format) bits.push(String(doc.format).toUpperCase());
      if (doc.numPages) bits.push(`${doc.numPages} 页`);
      if (doc.current) bits.push(`第 ${doc.current} 页`);
      meta.textContent = bits.join(' · ');

      item.append(name, meta);
      item.addEventListener('click', () => {
        if (doc.active) return;
        try {
          docs.switchTo(doc.id);
        } catch (err) {
          if (typeof app.toast === 'function') app.toast(`切换失败：${err.message}`, 'error');
        }
        refresh();
      });
      docListEl.append(item);
    });
  }

  async function refreshCacheSize() {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
      cacheRow.hidden = true;
      return;
    }
    try {
      const est = await navigator.storage.estimate();
      const used = Number(est && est.usage);
      if (!Number.isFinite(used)) { cacheRow.hidden = true; return; }
      cacheSizeEl.textContent = formatBytes(used);
      cacheRow.hidden = false;
    } catch {
      cacheRow.hidden = true;
    }
  }

  /* ── 诊断 ── */

  function setDiagStatus(text, bad) {
    diagStatus.textContent = text;
    diagStatus.classList.toggle('is-bad', !!bad);
  }

  function renderDiag(rows, tips) {
    diagTableWrap.textContent = '';
    diagTipsEl.textContent = '';

    if (!rows || !rows.length) {
      const p = document.createElement('p');
      p.className = 'settings-muted';
      p.textContent = '自检没有返回数据（app.js 的 runSelfCheck() 需改为返回 { rows, tips }）。';
      diagTableWrap.append(p);
      return;
    }

    const table = document.createElement('table');
    table.className = 'settings-diag-table';
    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const label = row && row[0];
      const value = row && row[1];
      const bad = !!(row && row[2]);
      const tr = document.createElement('tr');
      if (bad) tr.className = 'is-bad';
      const th = document.createElement('th');
      th.setAttribute('scope', 'row');
      th.textContent = String(label == null ? '' : label);
      const td = document.createElement('td');
      td.textContent = String(value == null ? '' : value);
      tr.append(th, td);
      tbody.append(tr);
    });
    table.append(tbody);
    diagTableWrap.append(table);

    if (tips && tips.length) {
      const ul = document.createElement('ul');
      ul.className = 'settings-tips-list';
      tips.forEach((tip) => {
        const li = document.createElement('li');
        li.textContent = String(tip);
        ul.append(li);
      });
      diagTipsEl.append(ul);
    }
  }

  async function runDiag() {
    if (diagBusy) return;
    diagBusy = true;
    setDiagStatus('检测中…', false);
    diagRunBtn.disabled = true;
    try {
      if (typeof app.runSelfCheck !== 'function') {
        renderDiag(null, null);
        setDiagStatus('app.js 未提供 runSelfCheck()', true);
        return;
      }
      const res = await app.runSelfCheck();
      diagRows = res && Array.isArray(res.rows) ? res.rows : [];
      diagTips = res && Array.isArray(res.tips) ? res.tips : [];
      renderDiag(diagRows, diagTips);
      if (!diagRows.length) {
        setDiagStatus('自检未返回数据', true);
      } else {
        const badCount = diagRows.filter((r) => r && r[2]).length;
        setDiagStatus(badCount ? `${badCount} 项需要处理` : '全部通过', badCount > 0);
      }
    } catch (err) {
      renderDiag(null, null);
      setDiagStatus(`检测失败：${err && err.message ? err.message : err}`, true);
    } finally {
      diagBusy = false;
      diagRunBtn.disabled = false;
    }
  }

  function buildDiagReport() {
    const v = app.version || {};
    const lines = [];
    lines.push('CAJ 阅读器 — 诊断报告');
    lines.push(`生成时间：${new Date().toLocaleString()}`);
    lines.push(`版本：${v.app || '开发版'}`);
    if (v.build) lines.push(`构建：${v.build}`);
    if (v.commit) lines.push(`提交：${v.commit}`);
    if (typeof location !== 'undefined') lines.push(`地址：${location.href}`);
    lines.push('');
    lines.push('── 检查项 ──');
    if (diagRows && diagRows.length) {
      diagRows.forEach((row) => {
        const flag = row && row[2] ? ' [!]' : '';
        lines.push(`${row && row[0] != null ? row[0] : ''}：${row && row[1] != null ? row[1] : ''}${flag}`);
      });
    } else {
      lines.push('（尚未运行自检）');
    }
    if (diagTips && diagTips.length) {
      lines.push('');
      lines.push('── 提示 ──');
      diagTips.forEach((tip) => lines.push(`- ${tip}`));
    }
    return lines.join('\n');
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* 继续尝试 execCommand 兜底 */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /* ── 关于 ── */

  function renderAbout() {
    const v = app.version || {};
    const ver = v.app ? String(v.app) : '';
    versionName.textContent = ver ? `CAJ 阅读器 v${ver}` : 'CAJ 阅读器';

    const meta = [];
    if (v.build) meta.push(`构建 ${v.build}`);
    const commit = shortCommit(v.commit);
    if (commit) meta.push(`提交 ${commit}`);
    versionMeta.textContent = meta.length ? meta.join(' · ') : '开发版（无构建信息）';

    versionApp.textContent = ver || '开发版';
    versionBuild.textContent = v.build ? String(v.build) : '—';
    versionCommit.textContent = v.commit ? String(v.commit) : '—';

    updateBox.textContent = '';
    const url = typeof app.updateUrl === 'string' ? app.updateUrl.trim() : '';
    if (url) {
      const hint = document.createElement('p');
      hint.className = 'settings-label-text';
      hint.textContent = '有网络时点下面的按钮打开发布页，下载最新版覆盖即可。';
      const link = document.createElement('a');
      link.className = 'settings-btn settings-update-link';
      link.id = 'setUpdateLink';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '更新到最新版';
      updateBox.append(hint, link);
      return;
    }

    // 没配发布页时，仍可以从站点根的 version.json 判断「有没有新版本」——
    // 这样用户不用自己比对版本号。拉不到就只给手动更新说明。
    const manual = document.createElement('p');
    manual.className = 'settings-muted';
    manual.textContent = '手动更新：拿到新版文件夹后，在旧版本目录里执行 '
      + 'node tools/update-ipad.mjs --from <新版目录>（会自动备份，可用 --rollback 回退）。';
    updateBox.append(manual);

    const status = document.createElement('p');
    status.className = 'settings-muted';
    status.id = 'setUpdateStatus';
    status.textContent = '正在检查更新…';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-btn';
    btn.id = 'setUpdateCheck';
    btn.textContent = '检查更新';
    updateBox.append(btn, status);

    const fmtVersion = (s) => String(s || '').split('.').map((n) => String(Number(n) || 0).padStart(4, '0')).join('.');
    const isNewer = (remote, local) => {
      if (!remote) return false;
      if (!local) return true;
      return fmtVersion(remote) > fmtVersion(local);
    };

    async function checkUpdate(showToast) {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = '检查中…';
      let published = null;
      try {
        published = typeof app.fetchPublishedVersion === 'function'
          ? await app.fetchPublishedVersion() : null;
      } catch { published = null; }
      btn.disabled = false;
      btn.textContent = original;

      if (!published) {
        status.textContent = '没有找到站点根的 version.json：当前可能是本地开发版本，'
          + '或发布时没带上版本清单。按上面的手动步骤更新即可。';
        if (showToast && typeof app.toast === 'function') app.toast('检查更新失败：没有版本清单', 'error');
        return;
      }
      if (isNewer(published.app, ver)) {
        status.textContent = `有新版本 ${published.app}`
          + (published.releasedAt ? `（发布于 ${String(published.releasedAt).slice(0, 10)}）` : '')
          + '，可以下载后手动覆盖。';
        if (typeof app.toast === 'function') app.toast(`发现新版本 ${published.app}`, '');
      } else {
        status.textContent = `已是最新版本（${published.app}）。`;
        if (showToast && typeof app.toast === 'function') app.toast('已是最新版本', '');
      }
    }

    btn.addEventListener('click', () => { void checkUpdate(true); });
    void checkUpdate(false);
  }

  /* ── 统一刷新（app 侧状态变化后会调它） ── */

  function refresh() {
    setSeg(themeSeg, themeValue());
    setSwitch(invertBtn, !!state().invert);
    setSwitch(sidebarBtn, sidebarDefault());

    const fit = state().fit === 'page' || state().fit === 'custom' ? state().fit : 'width';
    setSeg(fitSeg, fit);

    if (!scaleDragging) {
      const pct = currentPercent();
      scaleRange.value = String(pct);
      scaleValue.textContent = `${pct}%`;
    }

    rotateValue.textContent = `${Number(state().rotation) || 0}°`;
    pageGapSel.value = String(prefs.pageGap);
    setSeg(scrollSeg, prefs.scrollMode);

    renderDocList();
    renderAutoHeal();
    renderAbout();
  }

  /* ── 分区切换 / 开合 ── */

  SECTIONS.forEach(([id, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-tab';
    btn.dataset.setTab = id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.textContent = label;
    btn.addEventListener('click', () => showSection(id));
    tabsEl.append(btn);
  });

  function showSection(id) {
    const known = SECTIONS.some((s) => s[0] === id);
    currentSection = known ? id : 'appearance';
    Array.prototype.slice.call(tabsEl.children).forEach((btn) => {
      const on = btn.dataset.setTab === currentSection;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    qa('.settings-section').forEach((sec) => {
      sec.hidden = sec.dataset.setPanel !== currentSection;
    });
    bodyEl.scrollTop = 0;

    if (currentSection === 'files') refreshCacheSize();
    if (currentSection === 'diagnostics' && diagRows === null && !diagBusy) runDiag();
  }

  function isOpen() {
    return !overlayEl.hidden;
  }

  function open(section) {
    if (!isOpen()) lastFocused = document.activeElement;
    overlayEl.hidden = false;
    showSection(section || currentSection);
    refresh();
    try { closeBtn.focus({ preventScroll: true }); } catch { closeBtn.focus(); }
  }

  function close() {
    if (!isOpen()) return;
    overlayEl.hidden = true;
    const back = lastFocused;
    lastFocused = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) {
      try { back.focus({ preventScroll: true }); } catch { back.focus(); }
    }
  }

  function toggle(section) {
    if (isOpen()) close();
    else open(section);
  }

  /* ── 事件接线 ── */

  closeBtn.addEventListener('click', close);

  overlayEl.addEventListener('click', (event) => {
    if (event.target === overlayEl) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) close();
  });

  // 外观
  segButtons(themeSeg).forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.value));
  });
  invertBtn.addEventListener('click', () => setInvert(!invertBtn.classList.contains('is-on')));
  sidebarBtn.addEventListener('click', () => setSidebarDefault(!sidebarBtn.classList.contains('is-on')));

  // 阅读
  segButtons(fitSeg).forEach((btn) => {
    btn.addEventListener('click', () => applyFit(btn.dataset.value));
  });

  let scaleRaf = 0;
  scaleRange.addEventListener('input', () => {
    scaleDragging = true;
    scaleValue.textContent = `${scaleRange.value}%`;
    if (scaleRaf) return;
    scaleRaf = requestAnimationFrame(() => {
      scaleRaf = 0;
      applyScalePercent(scaleRange.value, true);
    });
  });
  scaleRange.addEventListener('change', () => {
    scaleDragging = false;
    applyScalePercent(scaleRange.value, true);
  });
  scaleRange.addEventListener('blur', () => { scaleDragging = false; });

  rotateBtn.addEventListener('click', applyRotation);
  pageGapSel.addEventListener('change', () => applyPageGap(pageGapSel.value));
  segButtons(scrollSeg).forEach((btn) => {
    btn.addEventListener('click', () => applyScrollMode(btn.dataset.value));
  });

  // 文件
  closeDocBtn.addEventListener('click', () => {
    if (typeof app.closeDocument === 'function') {
      try { app.closeDocument(); } catch (err) {
        if (typeof app.toast === 'function') app.toast(`关闭失败：${err.message}`, 'error');
      }
    } else if (typeof app.toast === 'function') {
      app.toast('当前版本不支持从设置里关闭文档（需要 app.js 提供 closeDocument()）', 'error');
    }
    refresh();
  });

  clearRecentBtn.addEventListener('click', async () => {
    const docs = app.docs;
    const fn = typeof app.clearRecentFiles === 'function'
      ? () => app.clearRecentFiles()
      : (docs && typeof docs.clearRecent === 'function' ? () => docs.clearRecent() : null);
    if (!fn) {
      if (typeof app.toast === 'function') {
        app.toast('当前版本不支持清空最近文件（需要 app.js / docs.js 提供 clearRecent()）', 'error');
      }
      return;
    }
    clearRecentBtn.disabled = true;
    try {
      await fn();
      if (typeof app.toast === 'function') app.toast('最近文件已清空', 'ok');
    } catch (err) {
      if (typeof app.toast === 'function') app.toast(`清空失败：${err.message}`, 'error');
    } finally {
      clearRecentBtn.disabled = false;
      refreshCacheSize();
    }
  });

  // 自动修复开关：默认开；关掉后打开/切换文档不再自动体检
  function autoHealState() {
    if (typeof app.autoSelfHeal === 'boolean') return app.autoSelfHeal;
    return true;
  }
  function renderAutoHeal() {
    setSwitch(autoHealBtn, autoHealState());
    autoHealBtn.textContent = autoHealState() ? '已开启' : '已关闭';
  }
  if (autoHealBtn) {
    autoHealBtn.addEventListener('click', () => {
      const next = !autoHealState();
      if (typeof app.setAutoSelfHeal === 'function') app.setAutoSelfHeal(next);
      renderAutoHeal();
    });
  }

  // 诊断
  diagRunBtn.addEventListener('click', () => runDiag());

  // 一键修复：重建文本层与布局，不重新打开文件、不丢标签
  repairBtn.addEventListener('click', async () => {
    if (typeof app.repairRuntime !== 'function') {
      if (typeof app.toast === 'function') app.toast('当前版本不支持一键修复', 'error');
      return;
    }
    repairBtn.disabled = true;
    const original = repairBtn.textContent;
    repairBtn.textContent = '修复中…';
    setDiagStatus('正在重建文本层与布局…', false);
    try {
      const res = await app.repairRuntime({ reason: '设置面板' });
      const left = (res && res.remaining ? res.remaining.filter((i) => i.auto) : []).length;
      setDiagStatus(left ? `修复后仍有 ${left} 项异常，请导出诊断报告` : `已修复 ${res?.fixed?.length || 0} 项`, !!left);
    } catch (err) {
      setDiagStatus(`修复失败：${err.message}`, true);
      if (typeof app.toast === 'function') app.toast(`修复失败：${err.message}`, 'error');
    } finally {
      repairBtn.disabled = false;
      repairBtn.textContent = original;
      await runDiag();
    }
  });

  warmCacheBtn.addEventListener('click', async () => {
    if (typeof app.warmOfflineCache !== 'function') {
      if (typeof app.toast === 'function') app.toast('当前版本不支持预热离线包', 'error');
      return;
    }
    warmCacheBtn.disabled = true;
    const original = warmCacheBtn.textContent;
    warmCacheBtn.textContent = '预热中…';
    try {
      const result = await app.warmOfflineCache();
      if (result && result.busy) {
        if (typeof app.toast === 'function') app.toast('离线包正在准备中，请稍候…');
      } else if (result && result.ok) {
        if (typeof app.toast === 'function') app.toast('离线包已就绪，可断网使用', 'ok');
      } else if (typeof app.toast === 'function') {
        app.toast('离线预热未完成', 'error');
      }
    } catch (err) {
      if (typeof app.toast === 'function') app.toast(`预热失败：${err.message}`, 'error');
    } finally {
      warmCacheBtn.disabled = false;
      warmCacheBtn.textContent = original;
      await runDiag();
    }
  });

  exportDiagBtn.addEventListener('click', async () => {
    if (diagRows === null) await runDiag();
    const ok = await copyText(buildDiagReport());
    if (typeof app.toast === 'function') {
      if (ok) app.toast('诊断报告已复制到剪贴板', 'ok');
      else app.toast('复制失败，请手动截图诊断结果', 'error', 7000);
    }
  });

  showDiagBtn.addEventListener('click', async () => {
    const show = globalThis.__cajShowDiag;
    if (typeof show !== 'function') {
      if (typeof app.toast === 'function') app.toast('完整诊断面板不可用', 'error');
      return;
    }
    if (diagRows === null) await runDiag();
    show({
      title: diagRows && diagRows.some((r) => r && r[2])
        ? `环境自检：${diagRows.filter((r) => r && r[2]).length} 项有问题`
        : '环境自检：全部通过',
      rows: diagRows || [],
      tips: diagTips || [],
    });
  });

  // 初始：把面板自身新增项同步到底层 hook / 根变量
  applyPageGap(prefs.pageGap);
  applyScrollMode(prefs.scrollMode);
  refresh();

  return {
    open,
    close,
    toggle,
    isOpen,
    refresh,
    /** 面板自有的阅读偏好（页面间距 / 滚动方式），供 app.js 的布局消费。 */
    getPrefs() { return { pageGap: prefs.pageGap, scrollMode: prefs.scrollMode }; },
    get section() { return currentSection; },
  };
}
