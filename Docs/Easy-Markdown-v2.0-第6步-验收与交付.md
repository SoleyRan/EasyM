# EasyM v2.0 第 6 步：Beta 与发布 验收与交付

分支：`feature/v2.0-step-6-release`，从 main `8a9e92a`（第 5 步合并，PR #20）创建。计划拆分：

- 6A：版本号、升级/回退与恢复说明。
- 6B：同提交三平台候选包、依赖许可与安装包验证。
- 6C：三平台实机验收与长时间离线试用，Beta 反馈闭环。

维护者决定：版本号先用 `2.0.0-beta.1`，在 GitHub 上标为预发布；Beta 反馈闭环后再发 2.0.0。签名/分发方式与实机验收分工待定，在此之前沿用 1.0 的不签名、手工下载安装。

## 6A：版本号与升级/回退说明（2026-11-02）

### 改动

- 版本号 `2.0.0-beta.1`：package.json、Cargo.toml/Cargo.lock、tauri.conf.json、侧栏版本、SBOM 元数据。
- 发布脚本：
  - `verify-release-metadata.mjs` 接受 `x.y.z` 或 `x.y.z-beta.N` / `-rc.N`，其他预发布写法拒绝。
  - `prepare-release.mjs`、`prepare-platform-release.mjs` 的候选版本校验从 `1.0.x` 改为 `2.0.x` 加可选 beta/rc。
  - Windows 候选附带的发行说明按版本号的主次号选择（`Easy-Markdown-v2.0-发行说明.md`）。
  - release.yml 起草的 Release 在版本含 `-` 时标为预发布。
- 便携包样例：便携包按主次号取 `Docs/samples/v2.0/`。v2.0 样例复制自 v1.0，体验指南新增“体验多设备同步”一节和同步/凭据人工检查项。
- 启动导引新增第 5 页“多设备同步”：入口、连接前预览、密码存放、合并与冲突副本、回收站、离线可写、同步不是备份。从 1.0 升级后的首次启动会显示“已更新到 EasyM 2.0.0-beta.1”。
- [2.0 发行说明](Easy-Markdown-v2.0-发行说明.md)：新增功能、平台与安装、从 1.0 升级、启用同步后新增的数据位置、关闭同步/卸载/回退到 1.0、不同版本的设备混用、恢复步骤、发行边界。

### 安装包对预发布版本号的处理

| 格式 | 行为 | 依据 | 处理 |
| --- | --- | --- | --- |
| Windows NSIS | 文件版本取 `2.0.0.0`；升级时按 semver 比较，beta.1 > 1.0.0，2.0.0 > beta.1 | Tauri 安装器模板（`SemverCompare`、`VIProductVersion`） | 无需处理 |
| macOS app/dmg | `CFBundleShortVersionString` 与 `CFBundleVersion` 都是 `2.0.0-beta.1`。Apple 要求 `CFBundleVersion` 为纯数字，只影响签名提交和上架 | Tauri `macos/app.rs` | 未签名分发不受影响；以后签名时配 `bundle.macOS.bundleVersion` |
| Linux deb | 实测 dpkg：`2.0.0-beta.1` 高于 `1.0.0`，但 `2.0.0` 不高于 `2.0.0-beta.1`（`-` 后是 Debian 修订号）；`2.0.0~beta.1` 才低于 `2.0.0` | `dpkg --compare-versions`（本机 nextcloud:31-apache 镜像内的 dpkg） | Tauri 不能单独改 deb 版本号；发行说明写明 Beta 升正式版时先卸载或用 `dpkg -i` |

### 兼容性核对

- 本地格式：`git diff v1.0.0` 中，历史、图片元数据、备份、草稿和最近文件的格式没有变化。只有三处新增：历史导入函数（跨目录移动用）、最近文件记录跟随改名、`images.json` 的受管路径判断改为对内导出。备份 manifest 的 schema 仍为 1；`producer_version` 会写成 `2.0.0-beta.1`，1.0 只检查 schema，因此能读取 2.0 做的备份。
- 1.0 对同步数据的处理：v1.0.0 的工作区树和搜索跳过所有以 `.` 开头的目录（`workspace.rs` 第 37、60、79 行），不会显示或改写 `.easym/sync/`、`.easym/trash/`。
- 旧版写入后的行为：在 1.0 中删除的文件不会被发布为删除，引擎测试“a missing local file is never published as a deletion”覆盖这一点。在 1.0 中新建、复制或改名产生的文件，会按 `adoptNewDocuments` 作为新文档加入。因此用 1.0 改名的文件，在其他设备上会出现旧名、新名两份，发行说明已写明。
- 凭据：钥匙串、凭据管理器中的服务名为 `EasyM Sync`（`sync_native.rs`），每个连接一条。
- Windows 卸载器的“删除应用程序数据”复选框会删除 `%APPDATA%`/`%LOCALAPPDATA%` 下的 `com.easym.markdown`（Tauri NSIS 模板），其中包括草稿和同步状态，发行说明已写明。

### 6A 验证

| 检查 | 结果 |
| --- | --- |
| `node scripts/verify-release-metadata.mjs` | `EasyM 2.0.0-beta.1: package, Cargo, lock, Tauri, UI and SBOM versions agree.` |
| `node scripts/verify-notices.mjs` | Windows：619 个依赖、347 个许可文件，无缺失 |
| `node --test scripts/prepare-release.test.mjs` | 2/2 通过：候选以 2.0.0-beta.1 命名，篡改、换提交、脏源码、缺安装证据时都被拒绝 |
| `cargo metadata --locked` / `cargo test --locked` | 锁文件与新版本一致；125 项通过、2 项按设计忽略 |
| `tsc -b`、`vite build` | 通过 |
| `vitest run` | 72 个文件、472 项通过；导引测试改为 5 页并检查同步页 |
| `verify-settings.mjs`、`verify-extension-delivery.mjs`、`verify-protection-delivery.mjs`（Edge 156） | 都通过：5 页导引的前后翻页和键盘导航、960×680 下不溢出、从旧版升级显示“已更新到”、设置中重新打开从第 1 页开始 |

### 6A 未验证

- 没有在本机构建 NSIS/DMG/DEB 实包，也没有实际执行 1.0 → 2.0 的安装升级。实包由 6B 在 CI 构建并验证安装/卸载。
- 回退到 1.0 的结论来自 v1.0.0 源码核对和引擎测试，没有用 1.0 安装包实际打开启用过同步的工作区。这一项列入 6C 实机验收。
- 完整 `verify:regression` 留给 CI。

## 6B：依赖许可与安装包验证（进行中，2026-11-02）

### 三平台许可清单

按 CI 相同的命令，在本机分别生成三个目标的清单（`cargo metadata --locked --filter-platform`，加 `pnpm licenses list --prod`），再用 `verify-notices.mjs` 校验：

| 目标 | 依赖数 | 许可文件 | 缺失文本 |
| --- | --- | --- | --- |
| x86_64-pc-windows-msvc | 619 | 347 | 0 |
| aarch64-apple-darwin | 616 | 351 | 0 |
| x86_64-unknown-linux-gnu | 733 | 399 | 0 |

仓库里只提交 Windows 清单；macOS、Linux 清单由 CI 在各自 runner 上重新生成，并校验安装包内附带的副本与之逐字节一致（`prepare-platform-release.mjs`）。

和 v1.0.0 的 SBOM 相比，Windows 新增 51 个包，都来自同步功能（reqwest、hyper、rustls、keyring 等），许可都是宽松许可：MIT、Apache-2.0、ISC、BSD-3-Clause，或其中几种任选。aws-lc-sys 的许可表达式由 ISC、Apache-2.0、MIT、BSD-3-Clause 组合而成，全文都已附带。macOS 多出的是 security-framework 和 objc2 系列（MIT / Apache-2.0 / Zlib）；Linux 多出的是 secret-service、zbus、dbus 和 GTK/WebKitGTK 绑定（MIT / Apache-2.0）。

需要注意的许可都是 1.0 已经带着的，2.0 没有新增：

- MPL-2.0：cssparser、cssparser-macros、dtoa-short、option-ext、selectors（Tauri/wry 依赖，未修改，许可全文已附带）。
- EPL-2.0：elkjs（Mermaid 布局）。
- 二选一许可，按宽松的一方使用：dompurify（MPL-2.0 OR Apache-2.0）、jszip（MIT OR GPL-3.0-or-later）。
- khroma 2.1.0 的元数据里没有许可字段，显示为 Unknown；附带的许可全文是 MIT。

以上是许可元数据和文本完整性检查，不是法律审查。

### Linux 运行依赖

Tauri 生成的 deb 只声明 `libwebkit2gtk-4.1-0`、`libgtk-3-0`。同步凭据通过 dbus-secret-service 动态链接系统的 `libdbus-1-3`（`libdbus-sys` 启用了 pkg-config 特性）。在 Ubuntu 24.04（amd64）上用 `apt-cache depends --recurse` 核对，`libwebkit2gtk-4.1-0` 本身就会间接拉入 `libdbus-1-3`，所以不必另外声明。保存密码还需要一个 Secret Service 服务（GNOME 钥匙环或 KWallet）。桌面版 Ubuntu 默认带有；没有的话，同步会报“系统凭据存储不可用”，且不会把密码写进文件。发行说明已写明这一点。

### Windows 安装包（本机）

- `pnpm tauri build --no-bundle` 加 `pnpm tauri bundle --bundles nsis`：生成 `EasyM_2.0.0-beta.1_x64-setup.exe`（6.84 MiB），文件名带预发布版本号，makensis 没有报错。
- 原生启动、安装/卸载、便携包这三项检查在本机做不了，原因都是环境：
  - 命令运行在非交互会话（`UserInteractive=False`），WebView2 创建窗口时报 `0x80070578`（无效的窗口句柄）。本机已安装的 0.7 版用同样方式启动，报同样的错误。
  - 本机只有 Windows PowerShell 5.1，它的 `Compress-Archive` 在 ZIP 条目里写反斜杠，便携包检查要求正斜杠。CI 用 pwsh 7。

  这三项以 CI 的 Windows runner 结果为准，不在本机补跑。

### 6B CI 候选（2026-11-02）

PR #21 合并后，main `7fb2f0e67d633135831d62c30491e472a815bb0e` 的 [Validate EasyM 41400030318](https://github.com/SoleyRan/EasyM/actions/runs/41400030318)（push，06:27–06:39 UTC）全部通过：

- frontend：`verify:release`、发布脚本测试、`verify:regression`。
- 三平台 desktop：`cargo test --locked`、按平台生成并校验许可清单、release 构建。
- Windows：原生启动与关闭、离线 Markdown 扩展、NSIS 构建、隔离安装/卸载、便携包、候选清单。
- macOS / Linux：DMG / DEB 构建，包内许可与源清单逐字节一致，候选清单。

候选 artifact（GitHub 记录的 artifact ZIP 摘要，不是安装包本身的哈希；安装包的 SHA-256 在各自的 manifest 和起草 Release 生成的 `SHA256SUMS.txt` 里）：

| Artifact | ID | 大小（字节） | ZIP SHA-256 |
| --- | --- | --- | --- |
| easym-windows-release-candidate | 13120329941 | 16,540,140 | `8200819e…169b` |
| easym-macOS-release-candidate | 13120743909 | 9,297,794 | `35076ba2…bcf` |
| easym-Linux-release-candidate | 13121331303 | 11,510,859 | `c816d337…c30` |
| windows-installer-verification | 13120569598 | 279,226 | `0df873df…121` |

Artifact 保留到 2027-01-31。签名与分发方式待维护者决定，在此之前沿用不签名、手工下载安装。

### Beta Release 草稿（2026-11-02）

维护者用 `Draft EasyM release`（`run_id=41400030318`）起草了 `v2.0.0-beta.1` 预发布草稿，未公开。工作流已重新核对三平台 manifest 的版本、提交和文件哈希。草稿中的 `SHA256SUMS.txt`：

```text
707a62640a3fd684d2307be737b882cdb3d10cc67a509a2c3487b0d4396fe6f0  EasyM_2.0.0-beta.1_x64-setup.exe
5da16e52ab821f1ba1268bdf6ce9da978bceda9c4e604c9f63e4aec8726bff7c  EasyM-2.0.0-beta.1-windows-x64.zip
77cfc4cc4c63960270d36fcacc2feea6412846b9a5c3ada39910ede10b8de81f  RELEASE-NOTES.md
d22a471d821f344e768b39bbb1b082bfba4bc0f686da73fe31048d6bac631112  EasyM-2.0.0-beta.1-macos-arm64.dmg
69d4a3056c299c4fba6719f75b2edb018b0594722ad37a894a032ce257dcdd82  EasyM-2.0.0-beta.1-linux-amd64.deb
04446ebcf3bfb0499f507973c5c34b22ed009d102282c030bf24333688888e05  release-manifest.json
e52711d7379658424385823681bf5d31ee5490ec538d4bd8f909241ee3b11079  release-manifest-macos-arm64.json
ef4ba05d371a959b59db6c7227a2df1a25a9aa3c1f11a69a3b8f84947f637b5b  release-manifest-linux-amd64.json
```

`RELEASE-NOTES.md` 的哈希等于提交 `7fb2f0e` 中 `Easy-Markdown-v2.0-发行说明.md` 换成 CRLF 后的哈希（Windows runner 检出时按 autocrlf 转换），说明附带的是该提交的发行说明。安装包哈希已填入[实机验收表](Easy-Markdown-v2.0-实机验收.md)。

本记录分支对发行说明的补充（未签名 macOS 升级后钥匙串可能再次授权）不在 beta.1 草稿附带的说明里。公开 Beta 前，可以把这一句手动加进 Release 正文。

### 6B 未完成

- 签名与分发方式待维护者决定，在此之前沿用不签名、手工下载安装。

## 6C：实机验收与长时间离线试用（待执行）

[三平台实机验收表](Easy-Markdown-v2.0-实机验收.md)：

- 沿用 1.0 的编辑器项目，补充两项：输入法组字过程中的 Tab/Enter，以及重命名、移动、回收站。
- 新增“同步与凭据”13 项，包括各平台凭据存储的授权和解锁、升级后 macOS 钥匙串是否再次请求授权（未签名包每个新版本在系统看来是另一个应用）、断网与中途退出、停用与重新加入、诊断脱敏、跨平台换行和大小写。
- 新增“升级与回退”4 项：从 1.0 升级、卸载重装、退出同步后回到 1.0、1.0 编辑后回到 2.0。
- 长时间离线试用：两台设备至少 7 天，第 7 天汇合同步并核对结果，再加一轮“离线期间被停用”。
- 发布判定：
  - 预发布公开前：三平台 CI 全绿；Windows 加另一平台的同步项全部有结果；确定签名方式。
  - 正式版前：三平台全部项目有结果；离线试用完成；Beta 阻断项关闭。

表中全部为待验，验收人和结果由实际操作的人填写。

## Beta 反馈修复：macOS 实机问题（2026-11-03）

分支 `fix/v2.0-beta1-macos`，从 main `442c236` 创建。维护者在 macOS 上用 beta.1 候选发现三个问题，另提一个需求。

| 反馈 | 原因 | 修复 |
| --- | --- | --- |
| 表格“删除当前行/列”没反应 | 删除非空行/列前要用 `window.confirm` 确认。wry 0.57 的 macOS WKUIDelegate 只实现了文件选择、媒体权限和窗口关闭三个方法，没有 `runJavaScriptConfirmPanel`，WKWebView 因此不弹框、直接返回 false，删除被取消。退出同步、停用设备、停用同步身份、移到回收站、重新加载外部版本、混合换行保存、历史关联等另外 9 处确认受同样影响 | 新增原生命令 `confirm_dialog`（`src-tauri/src/dialogs.rs`，rfd 消息框，按钮“确定/取消”）。前端统一经 `confirmAction`（`src/platform/dialogs.ts`）调用：只有 macOS 桌面版走原生对话框，Windows（WebView2）、Linux（WebKitGTK）和浏览器版继续用 `window.confirm` |
| “同步身份”“同步…”点不了 | 没有打开工作区时这两项是灰的，也没有说明。同步以文件夹为单位，只打开单个文件时不可用 | 两项保持可点；没有工作区时关闭菜单并提示“请先在 EM 菜单 → 打开工作区，选择要同步的文件夹”，悬停提示也写明原因 |
| 斜体显示不对 | 全局样式 `font-synthesis: none` 禁止浏览器合成倾斜字形，而苹方、微软雅黑等中文字体没有斜体字形，中文斜体显示成正体 | 改为 `font-synthesis: style`：允许合成斜体，仍禁止合成粗体 |
| 需求：阅读模式不进全屏 | — | 阅读模式只在当前窗口内切换，不再调用全屏，移除全屏 API 与 `allow-is-fullscreen`/`allow-set-fullscreen` 权限。窗口没有系统标题栏，所以桌面版阅读时保留一条 32 px 的顶栏，只含拖动区和最小化/最大化/关闭按钮；EM 菜单、标签和同步状态照旧隐藏。窗口大小变化不再退出阅读模式 |

### 验证

| 检查 | 结果 |
| --- | --- |
| `tsc -b`、`vite build` | 通过 |
| `vitest run` | 73 个文件、474 项通过。新增：`dialogs.test.ts`（macOS 走原生命令、Windows/Linux 走 `window.confirm`），App 测试“没有工作区时同步菜单可点并给出原因”。阅读模式测试改为不调用全屏、保留窗口按钮、调整窗口大小不退出 |
| `cargo test --locked` | 127 项通过、2 项按设计忽略。新增确认框消息校验和按钮结果判定两项 |
| `verify-writing.mjs`（Edge 156） | 通过：阅读模式不进入全屏，菜单、标签、源码和工具栏隐藏，Esc/按钮退出后正文不变 |
| `verify-tables.mjs`、`verify-extensions.mjs`、`verify-mermaid.mjs`、`verify-appearance.mjs` | 通过 |
| `verify-batch-images.mjs` | 第一次失败于 `OffscreenCanvas.convertToBlob`（图片读回失败），之后连续两次通过；main 上同样通过。判定为偶发，与本次改动无关 |
| 斜体对比（Playwright，纯中文 `<em>` 与普通文字截图比较） | Edge：`none` 时与正体相同，`style` 时倾斜，修复生效。本机 Playwright WebKit 两种设置都会倾斜，复现不了 macOS 系统 WebKit 的表现 |

### 未验证

- macOS 原生确认框（rfd → NSAlert）、斜体效果和阅读模式顶栏都需要在 Mac 上实际确认；本机是 Windows，CI 只验证构建与打包。
- Linux 的 WebKitGTK 是否正常显示 `window.confirm`，按 wry 的 GTK 实现推断，尚未实机确认。

## 2.0.0-beta.2 候选

PR #23 合并后（main `d3bf25c`），从 main 创建 `release/v2.0.0-beta.2`，只改版本号与文档：

- 版本号 `2.0.0-beta.2`：package、Cargo.toml/Cargo.lock、tauri.conf.json、侧栏、SBOM、发布脚本测试样例。`verify-release-metadata`、`verify-notices`、`prepare-release.test.mjs` 通过。
- [发行说明](Easy-Markdown-v2.0-发行说明.md)换成 beta.2，新增“相对 beta.1 的修复”。
- [实机验收表](Easy-Markdown-v2.0-实机验收.md)的候选信息清空，待 beta.2 的 CI 与草稿生成后填写；beta.1 的结果不沿用。
- Linux：按 Debian 版本比较规则，`2.0.0-beta.2` 高于 `2.0.0-beta.1`，从 beta.1 覆盖安装正常升级。本次 Docker 未运行，没有用 dpkg 实测。

beta.1 的预发布草稿未公开，也不再使用；起草 beta.2 后可以删除。

### beta.2 CI 与预发布草稿（2026-11-04）

PR #24 合并后，main `737464573d0ffc8c47d781022fc67992e7fa6608` 的 [Validate EasyM 41795187114](https://github.com/SoleyRan/EasyM/actions/runs/41795187114)（push，07:51–08:06 UTC）全部通过。维护者随后用 `Draft EasyM release`（[41797749140](https://github.com/SoleyRan/EasyM/actions/runs/41797749140)，`run_id=41795187114`）起草了 `v2.0.0-beta.2` 预发布草稿，未公开。

候选 artifact（ZIP 摘要，不是安装包哈希）：

| Artifact | ID | 大小（字节） | ZIP SHA-256 |
| --- | --- | --- | --- |
| easym-windows-release-candidate | 13305328988 | 16,550,512 | `8c281a6b…6c80` |
| easym-macOS-release-candidate | 13305327623 | 9,301,456 | `04564e6e…e003` |
| easym-Linux-release-candidate | 13304598910 | 11,539,723 | `52ce12b1…8ca9` |
| windows-installer-verification | 13305702788 | 279,239 | `27478f08…3b40` |

Artifact 保留到 2027-02-02。草稿中的 `SHA256SUMS.txt`：

```text
1ac488cbf0519ab7473e539d3f8a98cb6a25c07f76d447b6d96f69bf0e8f5a3f  EasyM_2.0.0-beta.2_x64-setup.exe
9fd23a9bb0cf065d50f455887ed86a0c9e4a9b5c8742e02eebfc8147799b11dd  EasyM-2.0.0-beta.2-windows-x64.zip
7237be586999ef975fa2246bcf68de6510c68801dd17b91521669c7987ce4ee8  RELEASE-NOTES.md
898365c417cfe31db75301e476c2d57739ea40acf36604bb8e2b2df401bccb97  EasyM-2.0.0-beta.2-macos-arm64.dmg
574782af782701344ff6480f2015e91f79bae757f6249f330315f88ab3473503  EasyM-2.0.0-beta.2-linux-amd64.deb
3423a7b10bc78f343c4936b904cfb7730f280b06a9b756016711e58817ec7040  release-manifest.json
2a939feab3a5c954e78bbe3f9d95011fd9d201ad6b6a4f4c9b20eeeef2285bc9  release-manifest-macos-arm64.json
d52d9f13ae793ef3861a723568bd9613c49dcab92a046c9303fac12bdc2a518f  release-manifest-linux-amd64.json
```

`RELEASE-NOTES.md` 的哈希等于提交 `7374645` 中 `Easy-Markdown-v2.0-发行说明.md` 换成 CRLF 后的哈希，附带的是含“相对 beta.1 的修复”的 beta.2 说明。安装包哈希已填入[实机验收表](Easy-Markdown-v2.0-实机验收.md)。

下一步：在 Mac 上安装 beta.2，先确认 beta.1 反馈的四项（确认框、斜体、阅读模式不全屏、同步菜单），再按验收表继续。

## Beta 反馈修复：阅读模式两侧边栏（2026-11-04）

维护者在 macOS 上用 beta.2 反馈：阅读模式下打开文件栏和大纲后，界面显得割裂。在 Edge 中按 1440×900 复现并测量：

- 两侧边栏背景是侧栏色 `--surface`，中间阅读区是页面色 `--page`，颜色不同。
- 中间一栏的顶部按钮行下边线、状态栏上边线只画在中间，到侧栏处断开。
- 桌面版阅读时的 32 px 顶栏是页面色，横跨整个窗口，压在两侧灰色侧栏上方。

修复（只影响阅读模式，编辑模式不变）：阅读时侧栏改用页面色，与阅读区连成一页；去掉中间一栏的上下横线；侧栏内侧的竖线保留，作为分隔。四个主题都通过 `--page` 变量生效。

验证：`verify-writing.mjs` 新增断言，两侧边栏都打开时，侧栏背景等于阅读区背景，上下横线透明；`verify-writing`、`verify-appearance`、`verify-settings` 和 App 测试（68 项）都通过。维护者提供的截图在本机读取为空，没能直接对照；修复依据的是上面的测量结果，需要在 Mac 上确认效果。

## 2.0.0-beta.3 候选

PR #26 合并后（main `88f5bf2`），从 main 创建 `release/v2.0.0-beta.3`，只改版本号与文档：

- 版本号 `2.0.0-beta.3`：package、Cargo.toml/Cargo.lock、tauri.conf.json、侧栏、SBOM、发布脚本测试样例。`verify-release-metadata`、`verify-notices`、`prepare-release.test.mjs` 通过。
- [发行说明](Easy-Markdown-v2.0-发行说明.md)换成 beta.3，新增“相对 beta.2 的修复”（阅读模式两侧边栏），beta.1 的修复列表保留并注明 beta.2 起已包含。
- [实机验收表](Easy-Markdown-v2.0-实机验收.md)的候选信息清空，待 beta.3 的 CI 与草稿生成后填写；beta.2 的结果不沿用。

beta.2 的预发布草稿未公开，起草 beta.3 后可以删除。

### beta.3 CI 与预发布草稿（2026-11-05）

PR #27 合并后，main `ca821d5c2bc6b7da0a32c7d108a2680ecbf77d87` 的 [Validate EasyM 41979682302](https://github.com/SoleyRan/EasyM/actions/runs/41979682302)（push，06:19–06:33 UTC）全部通过。维护者随后用 `Draft EasyM release`（[41981608644](https://github.com/SoleyRan/EasyM/actions/runs/41981608644)，`run_id=41979682302`）起草了 `v2.0.0-beta.3` 预发布草稿，未公开。

候选 artifact（ZIP 摘要，不是安装包哈希）：

| Artifact | ID | 大小（字节） | ZIP SHA-256 |
| --- | --- | --- | --- |
| easym-windows-release-candidate | 13394455529 | 16,551,940 | `b4f20424…9162` |
| easym-macOS-release-candidate | 13393558312 | 9,302,693 | `7473d408…c5f8` |
| easym-Linux-release-candidate | 13393248510 | 11,540,971 | `bb4bf2d3…82a6` |
| windows-installer-verification | 13393758217 | 279,227 | `ce21128a…f7cd` |

Artifact 保留到 2027-02-03。草稿中的 `SHA256SUMS.txt`：

```text
23bf74721ea25337b1fe4c198f3715ccc2b9dc5dfcc2580b3f491fbc3c8669a9  EasyM_2.0.0-beta.3_x64-setup.exe
47019c73d38b8c2fea1396d699859dc9bb8177a644aef421715d77c3d80bca77  EasyM-2.0.0-beta.3-windows-x64.zip
87477de4043f03c0a4c44a2c3e7c27e678769ec784b0f62763c7368a87d171e1  RELEASE-NOTES.md
fde7e0104844922823c8d46944f5532305ee8bf784a679a72df132ec5e3b8e06  EasyM-2.0.0-beta.3-macos-arm64.dmg
34f9260c2daf03a060360e83643e89f49b28d97868f07ea554dc473dca0b637d  EasyM-2.0.0-beta.3-linux-amd64.deb
300beaebaac3ebfff3836224a6073f5eeae75c61fe2258dca084b4e1b852c35d  release-manifest.json
dd5c2ff48b42327a7af81aa60d909e2da925843fa130236c431f4361879c912c  release-manifest-macos-arm64.json
a058fd281bfe95914ccd17b92196646f376bb2d6a4177d89966346750e7fe3f2  release-manifest-linux-amd64.json
```

`RELEASE-NOTES.md` 的哈希等于提交 `ca821d5` 中 `Easy-Markdown-v2.0-发行说明.md` 换成 CRLF 后的哈希，附带的是含“相对 beta.2 的修复”的 beta.3 说明。安装包哈希已填入[实机验收表](Easy-Markdown-v2.0-实机验收.md)。

下一步：在 Mac 上安装 beta.3，先确认阅读模式两侧边栏连成一页，以及 beta.1 反馈的四项，再按验收表继续。

## Beta 反馈修复：首次连接托管 Nextcloud 报 409（2026-11-05）

维护者用 beta.3 连接托管 Nextcloud 时，同步失败，提示 `unexpected_status:409`。

原因：连接时 `Dav::prepare` 要逐级创建 `easym-sync/v1/<工作区>/` 及其子目录。原代码从工作区目录往上只取两层，只建了 `easym-sync/v1/` 和工作区目录，漏掉了最外层的 `easym-sync/`。WebDAV 规定 MKCOL 的父目录必须已存在，否则返回 409（RFC 4918），所以在从没用过 EasyM 的账号上，第一次连接必定失败。第 1–5 步的测试容器里早已有 `easym-sync/`，问题一直没暴露。

修复：

- 要创建的目录改由 `namespace_collections` 生成，从 `easym-sync/` 开始逐级向下：`easym-sync/`、`v1/`、工作区、`devices/`、`objects/`、`objects/sha256/`。已存在的目录返回 405，照旧视为成功，已经连上的设备不受影响。
- HTTP 409 单独映射为 `endpoint_missing`，提示 WebDAV 地址指向的文件夹不存在，并说明 Nextcloud 应从“文件 → 文件设置”复制地址。这个错误不自动重试。

验证：新增 Rust 单测，检查目录按父目录在前的顺序生成；状态码映射测试加入 409；前端错误提示和“需要用户处理”的分类测试都通过。`cargo test` 128 项通过、2 项按设计忽略；`vitest` 474 项通过。

未验证：没有在真实的空 Nextcloud 账号上重测（本机 Docker 未运行，测试容器也已有 `easym-sync/`）。需要用下一个候选重新连接维护者的托管 Nextcloud 确认。连接失败前若已建出 `easym-sync/v1/` 之外的目录，新版会直接复用，无需手动清理。

## 2.0.0-beta.4 候选

PR #29 合并后（main `0f3f205`），从 main 创建 `release/v2.0.0-beta.4`，只改版本号与文档：

- 版本号 `2.0.0-beta.4`：package、Cargo.toml/Cargo.lock、tauri.conf.json、侧栏、SBOM、发布脚本测试样例。`verify-release-metadata`、`verify-notices`、`prepare-release.test.mjs` 通过。
- [发行说明](Easy-Markdown-v2.0-发行说明.md)换成 beta.4，新增“相对 beta.3 的修复”（首次连接报 409），之前各版的修复列表保留并注明起始版本。
- [实机验收表](Easy-Markdown-v2.0-实机验收.md)的候选信息清空，待 beta.4 的 CI 与草稿生成后填写；新增“首次连接从没用过 EasyM 的 WebDAV 位置”一项，用 Nextcloud 里新建的空文件夹验证 409 修复。beta.3 的结果不沿用。

beta.3 的预发布草稿未公开，起草 beta.4 后可以删除。

### beta.4 CI 与预发布草稿（2026-11-09）

PR #30 合并后，main `dc02566480e4d5ccb4ec40c60146d8b109cb1ba2` 的 [Validate EasyM 42581854371](https://github.com/SoleyRan/EasyM/actions/runs/42581854371)（push，07:50–08:04 UTC）全部通过。维护者随后用 `Draft EasyM release`（[42587145074](https://github.com/SoleyRan/EasyM/actions/runs/42587145074)，`run_id=42581854371`）起草了 `v2.0.0-beta.4` 预发布草稿，未公开。

候选 artifact（ZIP 摘要，不是安装包哈希）：

| Artifact | ID | 大小（字节） | ZIP SHA-256 |
| --- | --- | --- | --- |
| easym-windows-release-candidate | 13658106687 | 16,564,267 | `0e63d521…b506` |
| easym-macOS-release-candidate | 13657971958 | 9,291,438 | `f7832f9c…cdb6` |
| easym-Linux-release-candidate | 13658081505 | 11,526,200 | `0a21ae2e…d07a` |
| windows-installer-verification | 13657862277 | 281,185 | `446d559a…f66e` |

Artifact 保留到 2027-02-07。草稿中的 `SHA256SUMS.txt`：

```text
27a3cd3c904cc530a204cddd1b35c4425abb6ab0ab4c73bd785c4a8d03bda4a1  EasyM_2.0.0-beta.4_x64-setup.exe
835fd2d4cddb15f64ead27edbbe5715dbef9162145b2ed8340d68de30ab1aa7a  EasyM-2.0.0-beta.4-windows-x64.zip
2e6d846e4eaea2c56c3b29d055c425bd0a73e005b17e20016ab32830abbca4a0  RELEASE-NOTES.md
2b001313e20057d7b5f3cb96357b7d716c8b8821bc9680fb924f3494ffac4eb9  EasyM-2.0.0-beta.4-macos-arm64.dmg
6341d84d14db4c20e8af13b81baf846778a492e1881748b5b11b6b1df48e6093  EasyM-2.0.0-beta.4-linux-amd64.deb
d7715f0a188f3781d4611d28cfec4910c43ac953c2dd39bd1d84d8da5c7f70c4  release-manifest.json
226fd11785689562b657fd6ecfa131c31e4d92ceee049e1a97d6b106c1adae5f  release-manifest-macos-arm64.json
a2a30d9ffb07f83ea849f203f8d6f1b353407408f4374175a6231ec629ce854c  release-manifest-linux-amd64.json
```

`RELEASE-NOTES.md` 的哈希等于提交 `dc02566` 中 `Easy-Markdown-v2.0-发行说明.md` 换成 CRLF 后的哈希，附带的是含“相对 beta.3 的修复”的 beta.4 说明。安装包哈希已填入[实机验收表](Easy-Markdown-v2.0-实机验收.md)。

下一步：在 Mac 上安装 beta.4，用 Nextcloud 里新建的空文件夹验证首次连接不再报 409，再用第二个空工作区验证新设备拉取。

## Beta 反馈修复：嵌入 HTML 图片与即时渲染选取偏移（2026-11-10）

维护者用 beta.4 反馈两个问题。两个问题 1.0 就已存在，不是 Beta 新引入的。

| 反馈 | 原因 | 修复 |
| --- | --- | --- |
| `<p align="center"><img src="./images/x.png" width="600"></p>` 不显示图片 | 渲染器设置了 `allowDangerousHtml: false`，原始 HTML 被整段丢弃。完整设计方案 §4.4 要求渲染 `<img … width>` | 原始 HTML 用 `hast-util-from-html` 解析成片段，再经过原有的 `rehype-sanitize`，脚本、事件属性、`style`、iframe 和 `javascript:` 链接都会被去掉。`<img src>` 改为 `data-resource`，和 Markdown 图片走同一个只读本地文件的加载器，远程图片不会被请求。块级 HTML 保留源码范围，即时渲染也会显示；HTML 块里的图片保持行内显示，`align="center"` 能生效 |
| 即时渲染下鼠标选取的位置比鼠标所指的低 | CodeMirror 按块部件边框盒（`getBoundingClientRect`）的高度建高度表，`.live-rendered-block` 的 `margin: 8px 8px 16px` 不计入。每经过一个渲染块，实际排版就比高度表多出 24 px，点击被换算到更下面的行 | 块的间距改成 `padding`，外边距设为 0；表格块的顶部留白相应加到 42 px |

验证：

- `markdown.test.ts` 新增两项：维护者提供的原文能渲染出带 `width`、`alt`、`align` 的图片且没有直接的 `src`；嵌入 HTML 中的事件属性、样式、脚本、iframe、`javascript:` 链接被去除，远程图片不被请求。
- `verify-live-preview.mjs` 新增一项：在两个代码块、表格、分隔线和 HTML 图片下方拖选“选中文字”并加粗，结果必须落在目标行；HTML 图片带宽度、居中且不直接加载。把块样式临时改回 `margin` 后该项失败，加粗被插到文档末尾；改用 `padding` 后通过。
- `vitest` 73 个文件、476 项通过；`verify-live-preview`、`verify-export`、`verify-extensions`、`verify-extension-delivery`、`verify-protection-delivery`、`verify-writing`、`verify-appearance`、`verify-settings`、`verify-tables`、`verify-batch-images`、`verify-mermaid` 都通过。`verify-native-extensions` 需要先由 `.ps1` 启动原生应用，本机非交互会话无法启动，以 CI 为准。
- v2.0 样例 `降级与安全.md` 中“嵌入 HTML 保留为静态文本”改为说明按安全子集显示。

未验证：macOS 系统 WebKit 上的实际效果；需要在下一个候选上确认。

## Beta 反馈修复：结束符前是标点时不能加粗（2026-11-10）

维护者反馈：`**xxx**` 能加粗，`**xxx:**` 这类写法在某些情况下不能加粗。复现结果：结束的 `**` 前面是标点（冒号、括号等）且后面紧跟文字时不加粗，例如 `**注意:**后文`、`**注意：**后文`、`**(备注)**后文`；后面是空格或行尾时正常。1.0 就存在。

原因：CommonMark 规定，结束分隔符前面是标点时，后面必须是空白或标点才能结束强调。这条规则对中文不友好，GitHub 也这样渲染。预览（micromark）和编辑器（lezer）都按这条规则处理。

修复：采用 CJK 友好规则（[markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly) 规范），只在分隔符紧邻中日韩字符时放宽，其余情况保持标准 CommonMark。

- 预览、导出、DOCX、批量图片：`markdown-ast.ts` 的 remark 管线加入 `micromark-extension-cjk-friendly` 2.0.2（MIT）。
- 编辑器（即时渲染、工具栏状态、加粗切换）：lezer 没有对应选项，其强调分隔符类型是内部的。`cjk-emphasis.ts` 包装内置 `Emphasis` 解析器，由它创建分隔符，再用 `micromark-extension-cjk-friendly-util` 3.0.1 的同一套字符分类重算开闭标记，保证编辑器与预览判定一致。`@lezer/markdown` 固定为锁文件中已有的 1.7.2；`cjk-emphasis.test.ts` 检查所依赖的内部结构，升级时若变化会失败。
- 新增依赖都附带许可全文；Windows 许可清单重新生成：622 个依赖、349 个许可文件、无缺失。macOS/Linux 清单由 CI 生成。

验证：

- `cjk-emphasis.test.ts` 4 项：12 种应加粗的写法在预览和编辑器中都加粗；`a**xxx:**b`、`**Note:**text`、`2*3*4`、`snake_case_name` 等 6 种在两边都不加粗；单星号强调同样适用、下划线词内不变；未加扩展的 lezer 仍复现原问题。
- `verify-live-preview.mjs` 新增：即时渲染中 `**注意:**后文`、`前文**说明：**后文` 显示为粗体，`a**xxx:**b` 保持原样。
- `vitest` 74 个文件、480 项通过；`verify-live-preview`、`verify-writing`、`verify-export`、`verify-docx`、`verify-extensions`、`verify-tables`、`verify-extension-delivery` 都通过。

影响：放宽只发生在紧邻中日韩字符处，纯英文文档的渲染不变。少数以前按规范显示为字面 `**` 的中文写法，现在会显示为粗体。

## Beta 反馈修复：`./` 开头的图片路径显示“图片缺失或访问未授权”（2026-11-10）

维护者反馈：`<img src="./images/vscode.png">` 对应的文件存在，仍提示“图片缺失或访问未授权”。Markdown 写法 `![](./images/vscode.png)` 同样受影响，1.0 就存在。

原因：原生命令 `read_image` 的第一道检查允许 `./`，但随后调用的共享函数 `resources::safe_existing` → `relative()` 只接受普通路径段，`./` 被判为越界，返回 `permission_denied`。

修复：前端 `readImageBlob` 在调用原生命令前去掉 `.` 路径段（`./images/a.png` → `images/a.png`），与导出、DOCX 使用的 `localImagePath` 一致。原生侧的路径检查不放宽，它同时保护所有文件写入；`..`、绝对路径和反斜杠仍由原生侧拒绝。

验证：`storage.test.ts` 新增一项，`./images/vscode.png`、`images/./sub/a.png` 规范化后传给原生命令，`../outside.png` 原样交给原生侧拒绝；`tsc -b --force` 通过；`vitest` 74 个文件、481 项通过。图片仍只支持 PNG 和 JPEG。

## Beta 反馈：HTML 图片双击编辑、阅读模式双击放大（2026-11-11）

维护者反馈：嵌入 HTML 的图片能显示，但双击不能编辑；希望阅读模式下双击图片放大查看，而不是编辑。

实现：

- `src/core/html-images.ts` 扫描原始 HTML 中的 `<img>`，记录整个标签以及 `src`、`alt` 属性值在源码中的位置（支持双引号、单引号、无引号和实体）。`parseDocument` 把它们加入图片列表，渲染出的 `<img>` 带上 `data-source-from`。多行容器（如多行引用）中的 HTML 源码与解析值不一致，这类图片照常显示但不提供原位编辑。
- 应用编辑时 `commitImageChange` 只替换 `src` 和 `alt` 的值，`width`、`align`、外层 `<p>` 一个字节都不动；标签在编辑期间被改动时拒绝写入。
- 重命名/移动改写链接、同步、版本历史和备份收集引用时都识别 `<img src>`，编辑后生成的托管副本不会被漏掉。
- 即时渲染：HTML 块里的图片单击选中、双击编辑，不再单击就展开源码。
- 阅读模式：双击任意图片打开放大视图（`ImageZoom.tsx`），Esc 或点击关闭，仍停留在阅读模式，不打开编辑对话框。

验证：`html-images.test.ts` 5 项、`image-transaction.test.ts` 新增 1 项；`tsc -b --force` 通过；`vitest` 75 个文件、487 项通过。`verify-browser.mjs` 新增：分屏双击 HTML 图片编辑后 `width="40"` 和 `align` 保留；即时渲染双击打开编辑；阅读模式双击放大、Esc 不退出阅读模式、点击关闭、正文不变。`verify-live-preview`、`verify-writing`、`verify-batch-images`、`verify-extensions`、`verify-mermaid`、`verify-export`、`verify-tables`、`verify-extension-delivery`、`verify-protection-delivery` 均通过（`protection-delivery` 首次运行截图协议报错，重跑两次通过）。
