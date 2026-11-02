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

<!-- 6B -->
