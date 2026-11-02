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
