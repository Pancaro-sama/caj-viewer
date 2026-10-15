# iPad 部署流程

目标：在 iPad 的 Safari 里打开 `caj-viewer`，能选文件、能读 CAJ。
下面三条路线按「省事程度」排序，**路线 B 是推荐做法**。

---

## 先选路线

| | 路线 | 需要什么 | 耗时 | C8/HN-B 原生文字 | 可离线 |
|---|---|---|---|---|---|
| **A** | 局域网直连 | 同一 Wi-Fi 下的电脑 + Node.js | 1 分钟 | ❌ | ❌ |
| **B** | 静态托管（HTTPS） | 任意电脑上传一次 | 5 分钟 | ✅ | ✅ |
| **C** | 完全不用电脑 | iPad 上装 a-Shell | 10 分钟 | ✅ | ✅ |

**只想赶紧在 iPad 上看一篇 CAJ** → 走 A。
**想长期用、要能离线、要完整支持** → 走 B。

---

## 你的 iPad 版本够不够（重要）

**结论：iPadOS 15 及以上都可以。** 更早的系统打不开，页面上会直接给出提示。

为什么有下限：`vendor/pdfjs/` 里是 **PDF.js 6.x** 的构建产物（**不是 legacy 构建**），它运行期用到几个比较新的标准方法。项目用 `app/compat.js`（一个经典脚本，在 `app/app.js` 之前加载）把缺的方法补齐，不用联网、也不用你手动做什么：

| 方法 | 原生需要 | 谁在用 |
|---|---|---|
| `Promise.withResolvers()` | Safari 17.4 | pdf.js 构造传输层 |
| `Uint8Array.fromBase64()` / `fromHex()` | Safari 18.2 | pdf.js 读写内嵌二进制 |
| `Object.hasOwn()`、`Array.prototype.at()`、`findLast()` | Safari 15.4 | pdf.js 与转换引擎 |

补不回来的只剩**语法层面**的差异：#private 字段与 `static {}` 需要 Safari 14.1，顶层 await 需要 Safari 15。所以实际门槛是 **iPadOS 15**。

**怎么确认自己的版本**：iPad 上「设置 → 通用 → 关于本机 → 软件版本」。
**iPadOS 14 及更早怎么办**：只能走电脑端；或在电脑上把 `vendor/pdfjs` 换成 pdfjs-dist 的 `legacy/build/` 后重新打包（见 README「浏览器要求」）。

---

## 路线 A：局域网直连（1 分钟）

**1. 电脑上启动服务**

- Windows：双击 `start.cmd`
- macOS / Linux：终端里 `./start.sh`

**2. 记下打印出来的局域网地址**

```
──────────────────────────────────────────────────────────
  CAJ 阅读器 已启动（纯本地静态服务，文件不出本机）
──────────────────────────────────────────────────────────
  本机：      http://localhost:8080/
  局域网：    http://192.168.1.23:8080/   ← iPad / 手机用这个
──────────────────────────────────────────────────────────
```

**3. iPad 上打开**

确认 iPad 和电脑连的是**同一个 Wi-Fi**（注意别一个连 5G 一个连访客网络），
在 Safari 地址栏输入那行「局域网」地址。

**4. 打不开？先看电脑防火墙**

Windows 默认会拦掉 Node 的入站连接。第一次运行 `start.cmd` 时如果弹出防火墙询问，
选「允许访问」。如果当时点了「取消」，去
`控制面板 → 系统和安全 → Windows Defender 防火墙 → 允许应用通过防火墙`，
勾上 `Node.js` 的「专用网络」。

**路线 A 的能力边界（重要）**

`http://192.168.x.x` 在浏览器眼里**不是安全上下文**（只有 `https`、`localhost`、`127.0.0.1` 才是），
所以有两点限制：

- **没有跨源隔离** → 转换的「取消」不是立即生效，而是等 Worker 被终止；其余完全正常。
- **没有 OPFS** → C8 / HN-B 的**原生文字页**会因为拿不到字体包而报错。
  普通期刊 CAJ、KDH、HN-A 扫描件、PDF **完全不受影响**。
- Service Worker 不注册 → 不能离线，也不能真正「安装」。

需要完整能力就走路线 B。

---

## 路线 B：静态托管（推荐，5 分钟）

### 第 1 步：在电脑上打包

```bash
node tools/make-dist.mjs
```

产物在 `dist/`，约 66 MB（其中 58.6 MB 是 C8/HN-B 的字体包）。

**如果你的托管是 Cloudflare Pages，请改用：**

```bash
node tools/make-dist.mjs --without-fonts
```

因为 **Cloudflare Pages 拒绝上传超过 25 MiB 的单个文件**，完整包会传失败。
用 `--without-fonts` 后约 7.3 MB，代价是 C8 / HN-B 的**原生文字页**不可用（图片页照常）。
Netlify 和 GitHub Pages 没有这个限制，可以传完整包。

> 打包完成后，终端会主动列出身位超过 20 MiB 的文件并提示对应托管的上限。

### 第 2 步：上传

任选一种：

**① Netlify Drop —— 最省事，无需注册**

浏览器打开 <https://app.netlify.com/drop>，把整个 `dist/` 文件夹拖进去，
几秒后就会得到一个 `https://xxx.netlify.app` 地址。

> ⚠️ **别开「密码保护」。** Netlify 的 *Site configuration → Access & security →
> Password protection* 会拦住**整站**，包括 `app/app.js`。表现极具迷惑性：
> 页面能打开，但脚本加载失败，看起来就是「界面出来了、点什么都没反应」。
> 保持默认的关闭状态即可；本应用全部在本机运行，本来也不需要密码。

**② Cloudflare Pages**

`Workers & Pages → 创建 → Pages → 直接上传`，上传 `dist/`（记得先用 `--without-fonts` 打包）。
仓库里的 `_headers` 文件会被自动识别，跨源隔离与 `.wasm` MIME 都会配好。

**③ GitHub Pages**

```bash
cd dist
git init && git add -A && git commit -m "deploy caj-viewer"
git branch -M main
git remote add origin git@github.com:<你的账号>/caj-viewer.git
git push -u origin main
```

再到仓库 `Settings → Pages` 选择 `main` 分支根目录。
注意：**GitHub Pages 不支持自定义响应头**，`_headers` 会被忽略 —— 跨源隔离开不了，
应用照常工作，只是「取消」不是即时的（和路线 A 一样）。`.wasm` 的 MIME 由 GitHub 正确处理。

### 第 3 步：iPad 上打开并安装

1. iPad Safari 打开你拿到的 HTTPS 地址。
2. 等页面加载完（首次会缓存 PDF.js、WASM、字体表，约 5 MB；字体包 58.6 MB 只在读 C8/HN-B 时才下载）。
3. 点底部工具栏的 **分享** 按钮 → **添加到主屏幕**。
4. 桌面上会出现「CAJ 阅读器」图标，之后点它就能全屏打开。

**离线**：联网打开过一次之后，断网也能启动（Service Worker 已缓存外壳）。

**想确保「换本没读过的文档也能离线打开」**：装好之后点一次空状态里的
**「运行环境自检」**，面板底部有 **「预热离线包」** 按钮 —— 它会把运行时、
PDF.js 的解码器、标准字体、中文 CMap 以及那个 58.6 MB 的字体包全部拉进本机缓存
（完整约 65 MB，视网速需要几十秒到几分钟）。跑完自检里的「离线缓存」一行会显示
「已缓存 N 项（已可断网使用）」。不点也能用，只是没读过的 C8/HN-B 文档在离线时会缺字体。

> 「预热离线包」按钮只在 **HTTPS 或 localhost** 下出现；用局域网 `http://192.168.x.x`
> 访问时 Service Worker 不注册，自检会显示「不适用」，这时离线能力本来就不存在。

---

## 路线 C：完全不用电脑

iPad 上装 [a-Shell](https://holzschu.github.io/a-Shell_iOS/)（免费），
把 `caj-viewer` 文件夹放进「文件」App 的 a-Shell 目录，然后：

```
cd caj-viewer
python3 -m http.server 8080
```

再用 Safari 打开 `http://localhost:8080`。

`localhost` **是**安全上下文，所以路线 A 的那两条限制在这里都不存在 —— 完整功能可用。

缺点：a-Shell 需要保持前台或后台运行，切走可能被系统挂起。

---

## 部署后自检清单

按顺序确认，出问题时就能立刻定位是哪一层坏了：

| # | 检查 | 正常表现 | 不正常说明什么 |
|---|---|---|---|
| 1 | 页面能打开 | 标题「CAJ 阅读器 · 本地浏览器版」，中间有「选择文件」按钮 | 白屏 → 外壳没部署全，见下方排查 |
| 2 | 打开一个 CAJ | 文件名旁出现蓝色 **CAJ** 徽章，下面显示 `1 / N` 页码 | 只转圈 → 引擎没起来 |
| 3 | 滚动几页 | 每页都有内容，不出现连着好几页空白 | 见「滚动出现空白」排查 |
| 4 | 保存 PDF | 点右上角「保存 PDF」，能存到「文件」App | iOS 下载行为差异，可改用分享菜单 |
| 5 | 添加到主屏幕 | 桌面出现独立图标，点开无地址栏 | 必须是 **HTTPS** 才能安装 |
| 6 | 点「运行环境自检」 | 面板里「离线缓存」一行不标红；HTTPS 下可以顺手点「预热离线包」 | 显示「不适用」→ 当前不是 HTTPS/localhost，离线能力不可用 |

**如果第 1 步就卡住**（界面出来了但点什么都没反应）：页面脚本没能执行，
应用会在 3 秒后自动弹出诊断面板说明原因 —— 直接看它的「怎么办」即可，
详见下面的[界面出来了，但点什么都没反应](#界面出来了但点什么都没反应)。

---

## 常见问题排查

### 界面出来了，但点什么都没反应

这是最需要警惕的一类故障，因为它看起来「差一点就好了」。

**先让应用自己说。** 如果页面脚本没能执行，**3 秒后应用会自动弹出一个诊断面板**，
上面写着地址、协议、模块脚本有没有执行、以及捕获到的具体错误，下面还有「怎么办」。
照着做，或者点「复制诊断信息」把内容发出来。

如果没有自动弹出（说明脚本其实跑起来了），点空状态里的
**「运行环境自检」**，它会逐项检查引擎文件、WASM 编译、模块 Worker、存储、字符映射表。

**手动判断的关键一行是「模块脚本已执行」：**

| 该行显示 | 含义 | 去哪查 |
|---|---|---|
| **否** | `app.js` 压根没运行 | 部署问题，见下面三种原因 |
| **是** | 脚本跑了但中途失败 | 看「捕获到的错误」那一行 |

**四个最常见的原因，按概率排序：**

0. **托管商开了「访问保护 / 密码保护」**
   这是最隐蔽的一个，因为它看起来完全不像权限问题：**页面本身能正常打开，只有脚本被拦。**
   原因是密码保护会拦住整站（脚本也在内），而浏览器在页面通过验证后照常显示页面 ——
   于是就变成「界面在、脚本没跑」。

   诊断面板会直接告诉你：`入口脚本探测：HTTP 401 · text/html`、`判定：被访问保护拦截`。
   关掉它即可：**Netlify → Site configuration → Access & security → Password protection → 关闭**。
   Cloudflare 的 Cloudflare Access、Vercel 的 Deployment Protection 同理。

   自己快速验证：在同一个浏览器里直接访问 `你的地址/app/app.js`。
   看到源码 = 不是这个原因；看到密码页或 401 = 确认了。

   > 用 Netlify Drop 重新拖一次 `dist/` 会得到一个**全新的站点名**，默认不带任何保护，
   > 往往比去后台翻设置更快。

0.5 **入口脚本没问题，但它 import 的依赖没被正确下发**
   这类故障**最容易误诊**，因为浏览器报的是**入口文件**的名字：

   ```
   Failed to fetch dynamically imported module: https://…/app/app.js?cajprobe=…
   ```

   看起来像是 `app.js` 的错，其实它自己 `HTTP 200 · application/javascript` 好好的，
   出问题的是它 import 的某个文件。

   本项目真实踩过这个坑：早期 `vendor/` 里的模块是 `.mjs` 后缀，而**很多托管不把 `.mjs`
   当成 JavaScript 下发**（返回 `application/octet-stream`）。浏览器对模块脚本执行
   严格 MIME 检查，于是整个模块图被拒绝执行。本地一直没暴露，是因为 `serve.js`
   是我们自己写的、明确把 `.mjs` 映射成了 `text/javascript`。

   **现已从根上修掉**：`tools/normalize-vendor.mjs` 把 vendor 里所有 `.mjs` 统一改名为 `.js`
   并重写文件内部的模块说明符，`tests/dist-smoke.mjs` 会兜底检查产物里不含 `.mjs`。

   升级方法：重新打包并重新部署（`node tools/make-dist.mjs` → 重传 `dist/`）。

   诊断面板现在会**沿依赖链探一遍**并指名道姓：

   ```
   模块依赖探测   检查 5 个模块，第一个失败的依赖：/vendor/pdfjs/build/pdf.min.js → HTTP 404 · text/html
   ```

1. **直接打开了 HTML 文件（`file://`）**
   浏览器**禁止 `file://` 页面加载 ES 模块**，脚本根本不会执行，页面只剩静态外壳。
   必须用 `http://` 或 `https://` 打开 —— 也就是走路线 A / B / C 之一，不能双击文件。

2. **静态资源没传全**
   `index.html` 和 `app/`、`vendor/` 必须在**同一目录层级**下，相对关系不能变。
   只上传 `index.html` 是最典型的翻车方式。

3. **服务器没把 `.js` 当成 JavaScript 返回**，或被 SPA 回退规则改写成了 HTML
   **Safari 对脚本 MIME 比 Chrome 严格得多**：必须是 `text/javascript`
   或 `application/javascript`，否则直接拒绝执行。有些托管还会把所有找不到的路径
   重写到 `index.html`，于是脚本请求拿回一页 HTML。
   验证方法：在 Safari 地址栏访问 `你的地址/app/app.js`，应当**直接看到源码**，
   而不是弹出下载、也不是报错、也不该是一页 HTML。

> **另一个曾经踩过的坑：文件选择器弹不出来。**
> 早期写法是用 JS 去 `.click()` 一个 `display:none` 的 file input，而 iOS Safari 对此
> 限制很多，表现就是「按钮像死的」。现在两处打开文件的入口都改成了
> `<label for="fileInput">` 的**浏览器原生激活**，并且输入框改为「移到角落 + 全透明」
> 而不是 `display:none`，这条路上不再依赖 JS。如果你用的是旧版本，重新打包部署即可。

**白屏 / 只有背景色**

1. 多半是**只上传了 `index.html`，没上传 `app/` 和 `vendor/`**。必须把 `dist/` 整个目录传上去。
2. 托管在**子目录**（如 `user.github.io/caj-viewer/`）是支持的 —— 所有路径都是相对路径，
   但目录结构必须原样保留。
3. 用 Safari 的「开发」菜单或桌面浏览器打开同一个地址，看控制台报什么。

**打开 CAJ 一直停在「正在转换」**

- 先看进度百分比有没有在动。在动就是在解码，扫描版的大文件本来就慢。
- 完全不动：检查 `.wasm` 能不能下载。
  在 Safari 地址栏直接访问 `https://你的地址/vendor/caj2pdf-rust/caj2pdf_wasm.wasm`，
  应该会触发下载（约 2.4 MB）。404 说明 `vendor/` 没传全。

**提示「此浏览器缺少必要的存储能力」**

说明页面不是安全上下文（`http://` 局域网地址）。换 HTTPS，或按路线 B 部署。
出现这条提示只影响 C8 / HN-B 的原生文字页，其它格式照常。

**滚动时出现连着几页空白**

已在 v1.0 修复（根因是 `IntersectionObserver` 只在进入/离开时回调一次）。
如果你用的是旧版本，重新打包部署即可。当前版本有专门的回归测试盯着这一点。

**iPad 上文件是灰色的、点不动**

这是 iOS「文件」App 的行为，不是应用的问题。文件如果只在「最近使用」里、
还没真正下载到本机，就会被显示成灰色且不可选。解决办法：先在「文件」App 里
把它拷贝到「我的 iPad」或「iCloud 云盘」，再回到阅读器选择。

**无法「添加到主屏幕」或装完没有图标**

必须是 **HTTPS**。另外确认 `manifest.webmanifest`、`app/icon-180.png`、`app/icon-192.png`
都能访问到（不是 404）—— iOS 不认 SVG 作为主屏图标，所以主屏图标用的是 PNG。
如果主屏图标是一片空白或显示成网页截图，多半就是这两个 PNG 没传上去（它们都在 `app/` 里，
用 `node tools/make-dist.mjs` 打包的话会自动带上）。

**iPad 上点开文件完全没反应，控制台报 `Promise.withResolvers is not a function`**

你的 iPadOS 太旧（低于 15）。新版已经用 `app/compat.js` 补上了这些方法，重新打包部署即可；
如果补了仍然报错，说明是解析期就失败的语法差异（见上文[你的 iPad 版本够不够](#你的-ipad-版本够不够重要)），
这种情况只能升级 iPadOS 或改用 legacy 版 PDF.js。

---

## 更新已部署的版本

2.0 之后推荐用发布脚本，它会一并注入版本号并生成 `version.json`
（应用里「设置 → 关于 → 检查更新」读的就是它）：

```bash
node tools/release.mjs            # 注入版本 → 打 release/*.zip → 写 version.json
```

只想更新静态托管（HTTPS 路线）时，重新打包并上传即可：

```bash
node tools/make-dist.mjs          # 重新打包
# 然后把 dist/ 重新拖到托管上（Netlify Drop 再拖一次会得到新地址）
```

**a-Shell / 局域网路线（原地更新）** —— 把新包传到 iPad 后不用手工替换文件：

```bash
cd ~/Documents/caj-viewer
node tools/update-ipad.mjs --from ~/Documents/caj-viewer-new --dry-run   # 演练
node tools/update-ipad.mjs --from ~/Documents/caj-viewer-new             # 更新
node tools/update-ipad.mjs --rollback                                    # 回退
```

它只覆盖程序文件、不动用户自己的文件，更新前备份到 `.releases/`（保留最近 3 份）。

Safari 可能缓存旧外壳。`_headers` 里已经给 `index.html` / `app/*` / `sw.js` 设了 `no-cache`，
用 Netlify 或 Cloudflare Pages 托管时无需手工清缓存；GitHub Pages 上如果看到旧版本，
在 URL 后面加一个 `?v=2` 之类的查询串强制刷新一次即可。

> 改动过 `sw.js` 的 `SHELL_FILES` / `VENDOR_FILES` 或发新版时，记得把 `sw.js` 里的
> `VERSION` 常量加一（当前 `caj-viewer-v2`），否则老客户端会一直吃旧缓存。

---

## 为什么不建议把 `caj2pdf-fonts-v1.bin` 删掉

它只占磁盘、不占启动时间（**只在第一次读 C8 / HN-B 原生文字页时才按需下载**）。
删掉它，那类文档就会直接报错。只有当你确定永远不读 C8/HN-B，
或者受制于 Cloudflare Pages 的 25 MiB 限制时，才用 `--without-fonts`。
