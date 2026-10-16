# caj-viewer 2.0 改造契约（实现前必读）

本文件是本次并行改造的**唯一接口契约**。任何偏离都要先在 task 里说明，不要各自发明。

## 目标（用户原话，m00948）

1. 页面缩放中心点不准、不流畅、有抖动；在页面外缩放会导致页面剧烈滚动 —— 要模仿笔记类 App 的做法解决。
2. 增加设置界面，把自诊断等功能放进去。
3. 升级文件管理系统，方便在不同文件之间切换。
4. 优化更新流程，方便更新这个软件。

## 硬约束（不许破坏）

- **零构建、零 npm 依赖**：不许引入任何构建步骤或第三方运行时。新代码只能是普通 `.js` / `.css` / `.html`。
- **不得引入 `.mjs`**：`tests/dist-smoke.mjs` 断言产物里没有 `.mjs`（Netlify 等不把 `.mjs` 当 JS 下发）。新文件一律 `.js`。
- **app/app.js 保持 ES module**，靠 `import`/`export`；但 `app/compat.js` 必须是**经典脚本**（在 index.html 里以 `<script src>` 引入，不能用 `type="module"`），因为它要在模块图之前补齐缺失的标准方法。
- **iPad Safari 15+**：不许用比它更新的语法。不能用 `#private`（Safari 14.1+ 可以）、`static {}`（14.1+ 可以），但**不要用** `??=`/`||=`（Safari 14+ 可以，但保持保守）、不用 `structuredClone`、不用 `Array.prototype.toSorted`。新增缺失的标准方法请加到 `app/compat.js`。
- **不许改 vendor/ 下任何文件**，也不许改 `vendor/pdfjs/build/pdf.min.js` 的文件名或路径。
- 现有 61 项浏览器 e2e 断言 + 12 项 Node + 10 项 dist 断言必须继续全过。
- 写完必须能通过 `node --check <file>`（对 ESM 用 `node --input-type=module --check` 不便，用 `node -e "import('./app/xxx.js')"` 或跑 e2e 验证）。

## 负责人与写范围

| 谁 | 模块 | 独占写范围 |
|---|---|---|
| zoom-scribe | 双指缩放 | `app/pinch.js`（新建）、`app/style.css`（只动触摸相关规则） |
| settings-smith | 设置面板 | `app/settings.js`（新建）、`app/style-settings.css`（新建）、`index.html`（只动标记） |
| docs-arch | 文件管理 / 多文档 | `app/docs.js`（新建）、`app/style-docs.css`（新建）、`index.html`（只动标记） |
| lead | 集成与版本 | `app/app.js`、`app/version.js`、`tools/*`、`README.md`、`docs/*`（除本文件）、`tests/*` |

**`app/app.js` 与 `tests/browser-e2e.mjs` 只有 lead 能改。** 需要改动时，把「需要的挂载点 + 期望的 hook 名」写进 task 回报，由 lead 落地。

`index.html` 有两个人要动，因此**只允许在下面两处锚点插入标记**，其余行不许碰：

```html
<!-- ANCHOR:tabs --> 放在 <header id="toolbar"> 结束之后、<div id="searchBar"> 之前 —— docs-arch 在这里放标签栏
<!-- ANCHOR:settings --> 放在 <div id="progressOverlay"> 之前 —— settings-smith 在这里放设置模态
```

用 `grep -n 'ANCHOR:' index.html` 定位。

## 对外接口（严格按此实现）

### `app/pinch.js`（zoom-scribe）

```js
export function installPinch({ viewer, pagesEl, captureAnchorAtClientY, restoreAnchor, applyLayout,
  zoomTo, setFit, getStartScale, getZoomLabel, SCALE_PER_PERCENT, ZOOM_MIN, ZOOM_MAX }) -> { isActive(): boolean, cancel(): void }
```

- lead 会删除 app.js 里现有的 `const pinch = {...}` 与三个 `touchstart/touchmove/touchend` 监听（现 app.js:856-916），改为 `installPinch({...})`，并把原 `touchcancel` 一并交给它。
- `getStartScale()` 返回当前比例：`state.pages[state.current - 1]?.scale || state.customScale`。
- 几何要求（**这是 1 号问题的核心，必须严格按此实现**）：
  - 触控开始时记录 `k0 = 1`、`scroll0 = {left, top}`、`f0 = {x, y}`（焦点相对 viewer 的坐标）、`scale0 = getStartScale()`。
  - 每次 `touchmove` 用**当前**焦点 `f` 与 `k = dist / dist0`，直接写：
    `pagesEl.style.transformOrigin = '0 0'; pagesEl.style.transform = \`translate(${tx}px, ${ty}px) scale(${k})\``，
    其中 `tx = f.x - k * (scroll0.left + f0.x)`、`ty = f.y - k * (scroll0.top + f0.y)`。
    （推导：`p = f + k*(d - (scroll0 + f0))` ⇒ `translate = f - k*(scroll0+f0)`。用户要求「跟着手指、以两指中点为锚」。）
  - 手势全程**冻结滚动**：在 touchstart 时给 `viewer.style.overflow = 'hidden'`（并记下原值），结束/取消时恢复；**不要在 touchmove 里改 `scrollLeft/scrollTop`**（现在的实现一边改滚动一边改 transform，正是抖动的来源）。
  - 结束时（touchend 少于 2 指 / touchcancel）：
    1. 用**同一个公式**算出视觉状态，并令 `vis = { tx, ty, k, f, scroll0 }`；
    2. 清掉 `pagesEl.style.transform`（`transformOrigin` 保留 `0 0`）；
    3. `|k-1| > 0.02` 时 `zoomTo(scale0 * k)` 否则 `applyLayout()`；
    4. 立刻把滚动设成 `left = (scroll0.left + f0.x - tx)/k + f.x - (k-1)*0`…
       **不要照抄这行伪码** —— 按下面的不变式实现：
       > 不变式：`(视觉上落在焦点下方的文档点)` 在变换前后必须相同。
       > 变换中：文档点 `d` 映射到屏幕 `p = f + k*(d - (scroll0 + f0))`。
       > 布局后（`transform` 已清空，页面以新比例落在 DOM 坐标里）：`p = scrollNew + d`。
       > 因此 `scrollNew = f + k*(D - (scroll0 + f0)) - D`，其中 `D = scroll0 + f0`。
       > 即 `scrollNew.left = f.x + (k - 1) * (scroll0.left + f0.x) - ...` 请**自己把式子推平**，
       > 并写一个单元自测（见交付要求）验证「焦点不动」。
    5. 恢复 `viewer.style.overflow`；
    6. 最后 `restoreAnchor(anchorAtEnd)`（用结束时焦点 clientY 现算的锚点），确保不跳页。
  - **注意**：`zoomTo()` 内部会 `applyLayout()+renderVisiblePages()+saveSettings()`，是同步的，可以在它之后立刻改 `scrollTop/scrollLeft`。
  - 允许在 `requestAnimationFrame` 里只做一次 transform 写入（每帧一次），但**不要**节流到超过 1 帧。
- 另外必须顺带修掉一个真实冲突：app.js 现有双击缩放监听（`pointerup`，320ms 阈值）。双指捏合时两个手指各自会派发 `pointerup`，可能被误判成双击。`installPinch` 要导出 `isActive()`，lead 会在双击处理里加 `if (pinchApi.isActive()) return;`。
- `app/style.css`：给 `#viewer` 加 `touch-action: pan-y;`（不要用 `none`，否则单指纵向滚动会失效）。这是**唯一**允许在 style.css 里做的改动；新增样式放你自己的 `app/style-pinch.css` 并让 lead 在 index.html 里引入。
- 交付要求：附带一个纯逻辑自测脚本 `tests/pinch-math.test.mjs`，把上面的变换公式抽成纯函数验证：
  - 焦点不动：对随机 `k` 与 `f`，`scrollNew` 代入后算出的屏幕位置与 `f` 误差 < 0.01px；
  - 恒等：`k = 1` 时 `scrollNew === scroll0`；
  - 极点：`k` 触到 `ZOOM_MIN/ZOOM_MAX` 时仍满足焦点不动。
  （纯函数放 `app/pinch-math.js`，用 `export`，`pinch.js` 里 import 它。）

### `app/settings.js`（settings-smith）

```js
export function installSettings({ app, overlayEl }) -> { open(section?), close(), isOpen() }
```

- `app` 是 lead 提供的门面对象（**只读使用，不许改它的实现**）：

```js
{
  state,                          // app.js 的 state（只读）
  toast(msg, kind, ms),
  applyTheme(),                   // 主题已改后调用
  setFit(mode), zoomTo(scale), zoomBy(factor), rotate(),   // 动作
  saveSettings(),                 // 通知 app 持久化
  runSelfCheck(),                 // 返回 { rows, tips }；lead 会先把它改成返回数据而不是直接弹面板
  warmOfflineCache(),             // 预热离线包
  version: { app, build, commit },
  invalidateThumbnails(),
  openFile(file), closeDocument(),
  docs: { list(), switchTo(id), close(id) },   // docs.js 的实例，可能为 null
}
```

- DOM：`overlayEl` 就是 `index.html` 里 `<!-- ANCHOR:settings -->` 处那个容器 `<div id="settingsOverlay" class="modal-overlay" hidden></div>`（由你写成标记，lead 不改）。
- 面板必须包含这些**分区**（用左侧或顶部的分段控件切换，iPad 上要大触控目标 ≥44px）：
  1. **外观**：主题 自动/浅色/深色、页面反色（夜间读 PDF）、缩略图侧栏默认展开。
  2. **阅读**：适应宽度 / 适应整页 / 自定义比例（带滑杆，范围 15%–800%）、旋转、**页面间距**、**滚动方式（连续 / 单页）**。
  3. **文件**：当前文档列表（来自 `app.docs.list()`，为 null 时显示「暂不可用」）、关闭当前文档、清空最近文件、显示已用缓存大小（`navigator.storage.estimate()`，不可用时不显示这一行）。
  4. **诊断**：`runSelfCheck()` 的表格 + 「预热离线包」按钮 + 「导出诊断报告」（把 rows 拼成文本，用 `navigator.clipboard.writeText` 复制，失败时 toast 提示手动截图）。
  5. **关于**：「CAJ 阅读器 vX」、构建时间、commit、**「更新到最新版」**说明与跳转按钮（读取 `app.version`）。
- **不要把已有的工具栏按钮搬走**（`btnTheme`、`btnRotate`、`btnFitWidth` 等仍由 app.js 控制），设置面板是**第二入口 + 新增项**，两边必须双向同步状态：设置面板改动后调 `app.setFit()/zoomTo()/applyTheme()`，并由 `app` 侧在 `state` 改变后调用你暴露的 `refresh()` 重新渲染（lead 会在 `applyLayout()` 与 `applyTheme()` 里调 `settingsApi.refresh?.()`）。
- 所有样式写进 `app/style-settings.css`，用 `.settings-*` 前缀避免污染。
- 自诊断面板 `window.__cajShowDiag` 已经存在（index.html 内联脚本），可继续使用；但设置面板里的诊断区要**内联渲染**，不要弹全屏面板。

### `app/docs.js`（docs-arch）

```js
export function createDocManager({ viewer, el, state, api }) -> {
  addFromBlob({ blob, fileName, format, pages? }) -> id,
  list(),                 // [{ id, fileName, format, numPages, current, active }]
  switchTo(id), close(id), closeActive(), activeId(),
  restoreSession(),       // 启动时恢复上次的标签
  persist(),              // 防抖保存索引
}
```

- `api` 由 lead 提供：`{ mountInto(tab), snapshotFromDom(), toast(), loadPdf(blob) }` —— lead 会实现并把 app.js 的 `mountPdf` 拆成可复用的形式。**你负责设计并写明你需要的 `api` 精确签名**，写进 task 回报，由 lead 实现；不要自己改 app.js。
- 核心行为：每个标签页持有自己的 `pagesEl`（一个 `div#pages`）、`ObjectURL`、`pdfDocument`，**切换标签 = 换掉 viewer 里的 `#pages` 节点并恢复该标签的 `scrollTop`**，不需要重新转换、不需要重新解析。
- 标签栏 DOM 放在 `<!-- ANCHOR:tabs -->` 处，结构：

  ```html
  <div id="docTabs" class="doc-tabs" hidden>
    <div id="docTabList" class="doc-tab-list" role="tablist"></div>
    <button id="btnNewTab" class="doc-tab-new" title="打开新文件" aria-label="打开新文件">＋</button>
  </div>
  ```

  每个标签是 `button.doc-tab[data-id][role=tab]`，含文件名（超长省略号）+ 关闭按钮 `span.doc-tab-close`（点它只关这个标签，不切换）。横向可滚动，当前标签 `is-on` 并 `scrollIntoView({block:'nearest', inline:'nearest'})`。
- 持久化：索引写 `localStorage['cajviewer.docs']`（只存 `{id, fileName, format, current, scrollTop}`，不存二进制）。原始文件放 IndexedDB（库名 `cajviewer`、store `files`、key = id、value = `{ blob, fileName, format, addedAt }`），配额不足或隐私模式下**静默降级**（`toast` 一次即可）。`restoreSession()` 只恢复能取回 blob 的标签，取不回就丢掉该条索引。
- **iPad 上不要用 `FileSystemFileHandle` 持久化**（Safari 没有），只用 IndexedDB + 重新转换。单文件上限 100 MB，超了就只保留标签不持久化并提示。
- 样式写 `app/style-docs.css`，前缀 `.doc-*`。
- 注意：标签栏在窄屏（<560px）要占满宽度且能横向滚动，工具栏不能被挤坏。

## 验收（lead 负责，但你要自证）

现有全部测试必须继续通过：

```sh
node tests/make-fixtures.mjs && node tests/smoke.mjs          # 12/12
node tests/dist-smoke.mjs                                      # 10/10（先 node tools/make-dist.mjs）
node tests/browser-e2e.mjs                                     # 61/61（需要真实 Chrome；Windows 沙箱里要 danger-full-access，否则 Chrome crashpad 自杀）
```

新功能由 lead 在 `tests/browser-e2e.mjs` 里补断言。**你交付时请在 task 回报里写明：新增/修改的文件、关键函数签名、你自测的命令与结果。**
