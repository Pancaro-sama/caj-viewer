# iPad 随包部署（a-Shell / AirDrop）

这份说明对应 **不依赖 Git、不依赖电脑** 的部署方式：整个阅读器在压缩包里，解压到 iPad 的
a-Shell 目录，用一条命令起本地服务，再用 Safari 打开 `http://localhost:8080`。

`localhost` 是**安全上下文**，所以这条路线的能力是完整的：Service Worker、OPFS、
跨源隔离（`SharedArrayBuffer`）全都可用 —— 能离线、能预热离线包、C8/HN-B 原生文字页也能读。

---

## 0. 包里有两种版本，先选一个

| 版本 | 大小 | 什么时候用 |
|---|---|---|
| **完整版**（含 `caj2pdf-fonts-v1.bin`） | 66 MB（zip 33 MB） | 要读 **C8 / HN-B 的「原生文字页」**，或者想完全离线自用 → **默认拿这个** |
| **轻量版** | 7.3 MB（zip 3.2 MB） | 只读普通 CAJ / KDH / PDF，或者只是想先试试。读 C8/HN-B 原生文字页会提示缺字体（图片页不受影响） |

两个包内容完全一样，区别只是有没有那个 58.6 MB 的字体包。

---

## 1. 传到 iPad

**AirDrop**（iPad 和 Mac 之间最省事）：

1. 在 Mac / iPhone 上对着 zip 文件点 **分享 → 隔空投送** → 选你的 iPad
2. iPad 弹出接收提示 → 点 **接受**
3. 在 iPad 上打开**「文件」App** → 左侧栏 **「最近使用」**，zip 就在最上面

**或者**用「文件」App 直接放：iCloud Drive / 你的 NAS / 微信文件传输助手都行，最后落到「文件」App 里能访问的位置即可。

---

## 2. 让「文件」App 能看见 a-Shell（最常见卡点）

不一定要有 `a-Shell` 文件夹 —— 只要放在 **a-Shell 读得到** 的位置就行。

### 2A. 先用 iCloud Drive（最稳，不用折腾）

1. AirDrop 到 iPad → 文件 App 里 **长按 zip → 解压**（别双击快速查看，那样不会落地）。
2. 长按解压出来的 `caj-viewer` → **移动** → **iCloud Drive** → 移动。
3. 进 a-Shell 跑这条命令，把包搬到家目录：

   ```sh
   cp -R ~/iCloud/文件/caj-viewer ~/Documents/ 2>/dev/null || cp -R ~/iCloud/caj-viewer ~/Documents/
   ls ~/Documents/caj-viewer
   ```

   第一行失败就换第二行；路径取决于你在 iCloud 里放哪一层。`ls` 能列出
   `index.html app vendor sw.js` 就对了。

### 2B. 想直接放「我的 iPad」下

1. 「我的 iPad」看不见：点右上角 `…` → **编辑边栏** → 勾上「我的 iPad」。
2. 打开一次 a-Shell 并敲一次 `ls` 回车 —— a-Shell 只有在第一次真正运行后
   才会把目录暴露给「文件」App。
3. 回来刷新看看，一般就有 `a-Shell` 文件夹了。
4. 解压后把 `caj-viewer` 长按 → **移动** → **我的 iPad → a-Shell**。
5. 进 a-Shell 确认：

   ```
   ls ~/Documents
   ```

   应该看到 `caj-viewer`。

> a-Shell 目录暴露给「文件」App 依赖 iOS 的「App 文件夹」机制，个别版本
> 干脆不暴露。**卡住就别纠缠，走 2A，或者用下面的 2C 自己指定目录。**

> **别双击 zip 用"快速查看"**：那样只能看、不能落地。要么长按选解压，要么在「文件」App 里操作。
>
> **别重复嵌套**：如果 `ls ~/Documents/caj-viewer` 里面还有一个 `caj-viewer`，就是套了两层。
> 把里面那层的**内容**（`index.html`、`app`、`vendor`、`sw.js`、`manifest.webmanifest`）
> 移到 `~/Documents/caj-viewer/` 下面，保证 `index.html` 就在这一层。

### 2C. 用 a-Shell 自己挑目录（2A / 2B 都行不通时）

a-Shell 的 `pickFolder` 会弹出系统的目录选择器，把选中的目录登记成一条命令：

```sh
pickFolder
```

弹窗里选 **iCloud Drive**（或任何你放 zip 的地方），点「打开」。成功后敲：

```sh
docs          # 命令名由 pickFolder 输出，可能是 docs 之类
ls
```

能列出你在那个目录里的东西就说明通了，再 `cp -R caj-viewer ~/Documents/` 即可。

---

## 3. 起服务

在 a-Shell 里：

```sh
cd ~/Documents/caj-viewer
python3 -m http.server 8080
```

看到这一行就成了：

```
Serving HTTP on 0.0.0.0 port 8080 (http://0.0.0.0:8080/) ...
```

**让它停在这一屏，别按 Ctrl-C。** 起服务前先核对一下目录：

```sh
pwd                  # 应该是 /var/mobile/Containers/.../Documents/caj-viewer
ls                   # 应该看到 index.html  app  vendor  sw.js  manifest.webmanifest
ls -la vendor/caj2pdf-rust/caj2pdf_wasm.wasm   # 应该约 2.3 MB（不是 0 字节）
```

完整版再顺手确认字体包在：

```sh
ls -la vendor/caj2pdf-rust/caj2pdf-fonts-v1.bin   # 应该约 58.6 MB
```

---

## 4. Safari 打开

```
http://localhost:8080
```

**必须是 `localhost`（或 `127.0.0.1`），不要用 `192.168.x.x`。**
用局域网 IP 打开会丢掉 Service Worker 与 OPFS（自检里「离线缓存」会显示「不适用」），
也就没有离线能力。虽然功能看起来差不多，但这是这条路线的全部价值所在。

第一次打开会显示"CAJ 阅读器"空状态和底部工具栏。

---

## 5. 装到桌面 + 预热离线包（建议做，做完就一劳永逸）

1. Safari 里点 **分享 → 添加到主屏幕**。图标是蓝色 CAT 方块，之后从桌面点开是全屏 App。
2. 空状态里点 **「运行环境自检」**，翻到底部看 **「离线缓存」** 一行。
3. 点 **「预热离线包」**（约 65 MB，几十秒到几分钟，进度用 toast 提示）。
   跑完显示「离线包已就绪」，「离线缓存」一行变成「已缓存 N 项（已可断网使用）」。

**预热完成后，a-Shell 可以彻底关掉（后台卡片上滑划掉）** —— 桌面那个 App 照样能打开，网断了也能读没读过的文档，因为外壳和运行时都从 Service Worker 缓存拿，不再经过 a-Shell。

不预热也能用，只是 a-Shell 挂起后就打不开了（因为外壳本身也从 a-Shell 拿）。

关掉 a-Shell 之前，先确认这两件事：

1. 地址栏必须是 **`localhost:8080`**。`http://192.168.x.x:8080` 这种局域网地址拿不到安全上下文，Service Worker 根本不会注册，关掉 a-Shell 就必挂。
2. 自检里 **「离线缓存」** 一行要显示 **「已缓存 N 项（已可断网使用）」**。如果显示「不适用（局域网 http 下不注册 Service Worker）」，说明你正走在上面的局域网地址上。

想提前确认，就关掉 a-Shell 再点一次桌面图标 —— 能打开就说明真的离线可用。

---

## 6. a-Shell 被挂起怎么办

切到 Safari 后，a-Shell 靠 iOS 的后台保活撑几分钟，之后系统可能把它挂起，页面就会加载失败。

- 切回 a-Shell（从后台卡片），按 **↑ 上箭头**调出上一条命令，回车再跑一次即可
- 已经做过第 5 步的预热 → **挂起甚至彻底关掉都不影响**，走 Service Worker 的缓存
- 想要"不折腾"的长期方案 → 改用 HTTPS 静态托管，见 `docs/ipad-deploy.md` 路线 B

> **什么时候离线会失效**：在 iOS 设置里清掉 Safari 的"网站数据"、用无痕模式打开、长时间（几周）不开、或者储存空间吃紧被系统回收缓存 —— 这几种情况下需要重新起一次 a-Shell 再预热。a-Shell App 本身升级、删除都不影响缓存。

---

## 排错对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| Safari 打开是**文件列表**而不是阅读器 | 站在了上一级目录 | 必须 `cd` 进 `caj-viewer` 再起服务；确认 `pwd` 结尾是 `caj-viewer` |
| `python3: command not found` | a-Shell 版本不带 python3 | 在 a-Shell 里执行 `python3 -V` 确认；没有就改用托管路线 |
| `Address already in use` | 8080 被上一次的进程占着 | 换端口：`python3 -m http.server 8090`，Safari 开 `localhost:8090` |
| 页面出来了但**点什么都没反应** | 文件没搬全（尤其 `app/app.js` / `vendor/`） | `ls -R app vendor \| head -40` 核对；重新按第 2 步解压 |
| 一直停在「正在转换」 | `caj2pdf_wasm.wasm` 没下到或没搬全 | `ls -la vendor/caj2pdf-rust/caj2pdf_wasm.wasm`，应为约 2.3 MB |
| 自检里出现红字「缺少必要的存储能力」 | 不是用 `localhost` 打开的 | 换回 `localhost` |
| 读 C8/HN-B 报「自动字体需要 OPFS」 | 轻量版没有字体包 | 换完整版；或自检里点「预热离线包」（完整版才有） |
| 添加主屏后**没有图标** | 不是安全上下文 | 用 `localhost` 打开再添加 |
| 自检里「离线缓存」显示**不适用** | 同上，不是安全上下文 | 用 `localhost` 打开 |

---

## 2.0 新东西（用得上就看一眼）

**齿轮按钮 = 设置面板**（工具栏最右边）

- **外观**：主题（跟随系统 / 亮 / 暗）、页面反色、缩略图侧栏默认展开。
- **阅读**：适应宽度 / 适应整页、缩放滑杆、旋转、**单页模式**、**页面间距**（0 / 8 / 16 / 24）。
  这些偏好会记住，重启后照样生效。
- **文件**：当前打开的文档列表、关闭当前文档、清空「最近打开」的缓存。
- **诊断**：把「运行环境自检」的结果直接内联显示，带「离线缓存」状态和 **「预热离线包」** 按钮；
  还可以**导出诊断报告**，遇到问题把报告发出来就行。
- **关于**：版本号、构建时间、提交号，以及 **「检查更新」**。

**顶部标签栏 = 同时开好几个文档**

打开第二个文件时会自动新开一个标签，点标签切换，点标签上的 × 关闭。
关掉当前标签会自动切到旁边的，不会留在空白页。打开的文档会存在浏览器里，
**刷新页面或重新打开也能恢复**（超过 100 MB 的文件只记名字，不存副本）。

**双指缩放变准了**

2.0 重写了捏合手势：缩放时页面不会抖、不会跳，**你手指按住的那个点在缩放前后保持不动**，
页面滚出视野后缩放也不会突然乱滚。双击放大与捏合不会互相干扰。

**更新到新版本（原地更新）**

把新的 `caj-viewer-ipad-*.zip` 传到 iPad 并解压，然后在 a-Shell 里：

```sh
cd ~/Documents/caj-viewer
node tools/update-ipad.mjs --from ~/Documents/caj-viewer-new --dry-run   # 先演练，不写任何文件
node tools/update-ipad.mjs --from ~/Documents/caj-viewer-new             # 真正更新
```

- 只覆盖程序文件，**不会删你自己的文件**（放在文件夹里的笔记、PDF 都会留着）。
- 更新前自动备份到 `.releases/`（保留最近 3 份）。
- 想反悔：`node tools/update-ipad.mjs --rollback`。
- 不确定会不会动到什么：`node tools/update-ipad.mjs --list` 看它认识哪些版本。

> 从随包 zip 解出来的 `tools/` 里，脚本叫 `update-ipad.js`（部署产物不允许出现 `.mjs`）；
> 源码仓库里叫 `update-ipad.mjs`。两种都能用 `node` 直接跑，`ls tools/` 看一下实际名字。

> 更新完刷新 Safari 页面即可。如果「关于」里点「检查更新」提示有新版本，就是该走这一步了。

---

## 想只用几条命令搬过去？

如果你已经把 `caj-viewer` 放进 a-Shell 目录，完整流程就是：

```sh
cd ~/Documents/caj-viewer
python3 -m http.server 8080
```

Safari 打开 `http://localhost:8080` → 分享 → 添加到主屏幕 → 自检 → 预热离线包。完事。
