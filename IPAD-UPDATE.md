# 更新到新版本（iPad / a-Shell）

这份说明只讲一件事：**怎么把已经在用的 caj-viewer 换成新版本，同时不丢标签、不丢设置、出问题能退回。**

---

## 一、先分清两种更新

| 情况 | 怎么做 | 用户数据 |
| --- | --- | --- |
| 只是想读到新的**内容**（比如字体包、转换引擎） | 不用更新程序，刷新页面即可 | 不受影响 |
| 程序本身升级（app.js / app/ 下的模块 / vendor） | 按下面三步原地更新 | 不受影响（设置、最近文件在浏览器的 localStorage / IndexedDB 里，不在这个目录） |

判断依据：打开 **设置 → 关于**，看「版本」。站点根有 `version.json` 时会自动检查有没有新版本。

---

## 二、原地更新三步

前提：新版本已经传到 iPad（AirDrop 的 zip 或解压好的文件夹）。

1. 在「文件」App 里把新版本 zip 解压，得到一个 `caj-viewer` 文件夹（**不要**改名成别的）。
2. 回到 a-Shell，**进旧版本目录**，执行：

   ```sh
   cd ~/Documents/caj-viewer
   node tools/update-ipad.mjs --from ~/Documents/caj-viewer-new
   ```

   也可以直接指向 zip（脚本会自己解压）：

   ```sh
   node tools/update-ipad.mjs --from ~/Documents/caj-viewer-ipad-full.zip
   ```

   > **后缀说明**：从随包 zip 解出来的 `tools/` 里，这两个脚本叫
   > `update-ipad.js` / `inject-version.js`（部署产物不允许出现 `.mjs`，
   > 详见 README）。源码仓库里它们叫 `update-ipad.mjs` / `inject-version.mjs`。
   > 两种后缀都能用 `node` 直接跑，`ls tools/` 看一下实际叫什么就行。

3. 重开服务并刷新 Safari：

   ```sh
   python3 -m http.server 8080
   ```

   然后 Safari 下拉刷新；如果是从桌面图标打开的，先划掉再从图标重开。

更新完成后 **设置 → 关于 → 版本** 会显示新版本号。

---

## 三、先把话说清楚：它会改什么

- **会覆盖**：程序文件（`index.html`、`app/`、`vendor/`、`sw.js`、`tools/`、文档等）。
- **不会删**：目录里其它文件（比如你自己放的 .caj 文件、笔记）。
- **自动备份**：更新前把当前版本整目录复制到 `.releases/<旧版本>-<时间戳>/`，只保留最近 3 份。
- **先校验再动手**：新版本缺 `index.html`、`app/app.js`、`app/compat.js`、`vendor/` 里任何一个必需文件，脚本直接中止，不会留下半个版本。

---

## 四、更新前先演练（强烈建议）

```sh
node tools/update-ipad.mjs --from ~/Documents/caj-viewer-new --dry-run
```

只做校验和体积统计，不写盘。看到「检查通过」再执行真正的更新。

---

## 五、更新后出问题：回退

```sh
node tools/update-ipad.mjs --rollback
```

脚本会把最近一次备份覆盖回来，并在 `.caj-version.json` 里记下 `rolledBackAt`。再次重开服务、刷新 Safari 即可。

查看当前版本与所有备份：

```sh
node tools/update-ipad.mjs --list
```

---

## 六、常见问题

**执行 `node` 提示找不到命令** — a-Shell 里 `node` 和 `python3` 都自带，确认你敲的是 `node` 而不是 `nodejs`。

**提示「来源不存在」** — 路径不对。在 a-Shell 里 `ls ~/Documents/` 看看新版本文件夹到底叫什么；「文件」App 里的 iCloud 目录在 a-Shell 中是 `~/iCloud`。

**提示「新版本不完整，缺少 …」** — 解压只解了一半，或者 AirDrop 中途断了。重新解压一次；zip 里的顶层目录必须只有一层 `caj-viewer/`。

**更新完打开还是旧版** — 浏览器缓存。Safari 下拉刷新；从主屏图标打开的先划掉再重开；仍然旧就清一次 Safari 缓存。

**想回到最开始那一版** — 在 `.releases/` 里找最老的目录，用 `--from` 指过去再更新一次。

**换到新 iPad / 新目录** — 直接把整个 `caj-viewer` 文件夹拷过去即可，程序是自包含的，没有安装步骤。

---

## 七、给发布者（你自己的电脑上）

```sh
node tools/release.mjs
```

这一条命令会：注入版本号 → 重新打包完整版与轻量版 zip → 生成站点根的 `version.json`。
产物在 `release/`：`caj-viewer-ipad-full.zip`、`caj-viewer-ipad-lite.zip`、`IPAD-UPDATE.md`、`SHA256SUMS.txt`。
