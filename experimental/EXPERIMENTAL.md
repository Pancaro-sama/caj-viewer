# CAJ 阅读器 · 实验版（不稳定，可能还有 bug）

- 稳定版：<https://pancaro-sama.github.io/caj-viewer/>
- 实验版：<https://pancaro-sama.github.io/caj-viewer/experimental/>
- 实验版代码：`git branch experimental`（分支基于稳定版 `91dc1d8`）
- 本副本来自提交 `b331912`（版本号仍写 2.0.0，`app/version.js` 里 `commit=b331912`）

> 这是实验分支的部署副本。它包含一组针对 iPad 上反馈问题的修复，但**尚未在真机上验证充分**，
> 已知存在较多未复现/未定位的差异。遇到问题请先用稳定版，并把自检结果反馈。

## 相对稳定版（`91dc1d8`）改了什么

1. **文本层缩放变量补全**（`app/style.css` 的 `.page`）—— pdf.js 的 `--scale-factor` /
   `--total-scale-factor` 原先只在 `vendor/pdfjs/pdf_viewer.css` 的 `.pdfViewer .page` 下定义，
   本应用用的是 `#viewer` + `.page`，匹配不到，导致文本层字号退化成浏览器默认值、文字叠在一起、
   查找看起来失效。这是「查找 0/0 + 文字糊成一片」的根因。
2. **文本层节点重建** —— `releasePage()` 会把 textLayerDiv 从 DOM 摘掉但不重置 `p.textLayerDiv`，
   原来只在字段为空时新建，重建时会 append 到永远不在文档里的孤儿子树。
3. **侧栏跟随文档切换** —— 新增 `restoreDocPanes()` / `refreshOutlineUi()`；`loadOutline()`
   无目录时显式清空 `state.outline`（原来是提前 return，把上一个文档的目录留在原地）。
4. **格式徽章按文件名优先** —— 新增 `KNOWN_FILE_FORMATS` + `formatLabel(source, detected)`，
   `.caj` 文件不再因为引擎探测成 `kdh` 就显示成 KDH。
5. **自检 / 一键修复** —— `detectRuntimeIssues()` / `repairRuntime()` / `selfHealNow()`，
   设置面板里有按钮；判定逻辑抽成纯函数 `summarizeTextLayers` / `textLayerIssueFrom`。
6. **保存 PDF 面板** —— 保存通道按真实能力分优先级（另存为 > 分享面板 > 浏览器下载）、
   显示下载地址、切标签自动关闭面板、`saveExport()` 在 await 前固定 `objectUrl`。
7. **Service Worker** —— 导航改为网络优先 + 超时回退；只有真正的 HTML 才写缓存；
   `install` 预缓存失败时不抢激活。缓存版本从 `caj-viewer-v3` 升到 `caj-viewer-v4`。

## 已知问题

- iPad 真机上的表现尚未逐一验证（本地只有桌面无头 Chrome 的 e2e 全套：109/109）。
- 竖屏字体重叠问题在本地无头环境下未复现，第 1 条修复是否真正解决真机表现待确认。
- 实验版与稳定版共用同一个域名，Service Worker 作用域各自独立（稳定版 `/`、实验版 `/experimental/`），
  但两者都往浏览器缓存里写数据。

## 回退

稳定版已经回退到 `91dc1d8`（含保存 PDF 面板，不含上面这批新改动）。
`main` 分支被强制重置到该提交；实验代码只存在于 `experimental` 分支。
