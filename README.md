# EasyM

EasyM 是本地优先的 Markdown 桌面编辑器，使用 React、CodeMirror 和 Tauri 2。文档保存在自己的目录中，支持源码、分屏和即时渲染。

## 1.0 状态

当前分支 feature/v1.0，正在完成 1.0.0 发版收尾，尚未发布正式 Release。范围见 [发布计划](Docs/Easy-Markdown-v1.0-发布计划.md)，功能、升级方式、已知限制及实机检查见 [发行说明](Docs/Easy-Markdown-v1.0-发行说明.md)。历史阶段和证据保留在 Docs 中，不把旧版本检查当作本轮验收。

## 功能

- 多文档标签、工作区与大纲、双向滚动同步、查找替换、模板、命令面板与快速打开。
- 选区格式切换、语法高亮和代码语言选择、可视化表格、图片副本编辑与批量处理。
- 四种配色、字号和排版设置、阅读模式、自定义窗口和右键菜单。
- 脚注、Front Matter、离线数学公式和 Mermaid；HTML、可编辑 DOCX、系统打印/PDF。
- 自动保存、草稿与会话恢复、最近文件、可选版本历史与文字/图片对照。
- 外部修改检测、三方合并、合并前强制归档与单文档备份/恢复。

已命名文档停止输入 1.2 秒后自动写回。新文档先保留草稿，首次需另存为。外部冲突和写入失败暂停自动保存并提示。版本历史需显式启用；草稿和历史不能代替备份。浏览器模式用于开发验证，原生目录和部分数据保护能力仅桌面版提供。

## 下载和使用

正式下载以 [GitHub Releases](https://github.com/SoleyRan/EasyM/releases) 为准。Windows x64 包需要 WebView2 Runtime；当前没有签名或自动更新。1.0 按三平台同时正式发布；正在等待 Windows/macOS/Linux 实机验收，自动构建通过不代替该验收。首发目标为 Windows x64、macOS Apple Silicon、Ubuntu 24.04 x86_64。

目标文件名：EasyM_1.0.0_x64-setup.exe、EasyM-1.0.0-windows-x64.zip。下载后可使用 PowerShell 的 Get-FileHash -Algorithm SHA256 核对同次发行的 SHA256SUMS.txt。便携包附带 [体验指南与样例](Docs/samples/v1.0/README.md)，练习前复制到临时目录。

升级保留应用标识和已有数据格式；先保存退出并备份文档、.easym 及自定义历史目录，不清除 WebView 存储。首次启动/版本变化会展示四页使用导引，EM → 设置可重新查看。

## 开发

使用 Node.js 22+，pnpm 版本由 `package.json` 的 `packageManager` 字段锁定：

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm verify:workers
pnpm verify:docx-library
pnpm verify:docx
pnpm verify:docx-ui
pnpm verify:history
pnpm verify:settings
pnpm verify:batch-images
pnpm verify:release
pnpm exec playwright install chromium
pnpm verify:browser
pnpm verify:writing
pnpm verify:search
pnpm verify:live
pnpm verify:workspace
pnpm verify:templates
pnpm verify:export
pnpm verify:extensions
pnpm verify:math
pnpm verify:mermaid
pnpm verify:extension-delivery
pnpm verify:context-menu
pnpm verify:commands
pnpm verify:tables
pnpm verify:content-tools
pnpm verify:quick-entry
pnpm verify:appearance
pnpm verify:session
pnpm verify:recent
pnpm verify:external
pnpm verify:merge
pnpm verify:backup
pnpm verify:protection-delivery
pnpm verify:performance
pnpm verify:regression --performance
```

构建后可用 `pnpm verify:regression` 串行执行全部功能回归，添加 `--performance` 同时测量性能。CI 使用统一入口，性能数据在本机单独记录；各项命令仍可独立运行。`pnpm verify:search --slow` 和 `pnpm verify:templates --slow` 使用 6 倍 CPU 降速验证初始化及标签标题更新竞态；正文 fixture 等待草稿初始化后的可用编辑区。依赖清单生成后运行 `node scripts/verify-notices.mjs`，核验 SBOM 版本、许可文件字节哈希、链接大小写和补充文本来源。

Windows 已安装 Microsoft Word 时，可在 `verify:docx-ui` 后运行 `./scripts/verify-docx-word.ps1`，以独立隐藏实例验证测试产物的打开、分页、编辑保存和再打开。DOCX UI/Word 报告位于 `test-results/`；详见 3C 记录，自动结构检查不能代替各办公软件的实际排版验收。

安装 Rust、系统 WebView 和 Tauri 依赖后，可以运行：

```bash
pnpm desktop:dev
pnpm desktop:build
```

Windows PowerShell 若拦截 `.ps1` 启动脚本，使用 `pnpm.cmd`。应用图标已包含在项目中，SVG 源文件位于 `src-tauri/icons/app-icon.svg`；修改后运行 `pnpm.cmd icons` 重新生成各平台图标。

已有 Microsoft Edge 时，PowerShell 可设置 `$env:EASYM_TEST_BROWSER = 'msedge'`，使用它运行浏览器检查，无需另装 Chromium。检查会创建独立的无头浏览器配置，不读取日常浏览器或桌面应用的草稿。性能脚本的事件到下一帧延迟仅作本机基线，不能代替真实 WebView/输入法验收。报告输出在 `test-results/`。

Windows 构建产物位于 src-tauri/target/release/。安装包使用 pnpm.cmd tauri build --bundles nsis；便携包使用 ./scripts/package-portable.ps1，逐文件验证许可和样例。原生启动/扩展检查分别使用 verify-native-startup.ps1 和 verify-native-extensions.ps1，均使用隔离配置。安装/卸载检查仅在一次性 Windows CI runner 执行，不替换开发机现有安装。

## 发行流程

CI 为 Windows 生成 NSIS/ZIP、macOS ARM64 生成 DMG、Linux x86_64 生成 DEB，各自附带 SHA-256 和绑定提交的 manifest，保存为对应 release-candidate artifact。三平台测试及严格许可检查全部成功后，在同一提交上手动运行 Draft EasyM release，填写对应 Validate EasyM 的 run ID。流程核对三平台提交、版本、完整测试和所有文件哈希，复用测试过的包创建草稿，不重新构建；缺任一平台候选则失败。未完成上传或校验不得公开草稿；发布前按发行说明完成实机检查并确定签名/分发方式。流程不自动公开 Release、不替代人工验收。

本地可运行 node scripts/prepare-release.mjs 收集包；有未提交源码时会标明 sourceDirty，发布校验拒绝该候选。node scripts/record-build.mjs Docs/verification/v1.0/local 记录本机产物及回归证据。

## 许可

项目采用 [Apache-2.0](LICENSE)。只借鉴 MarkText 的交互设计，独立实现，没有引入其代码或资源。

实际第三方依赖见 [许可清单](Docs/dependencies/THIRD-PARTY-NOTICES.md) 和 SBOM。CI 分目标重新生成库存并严格检查文本/哈希/来源；objc2 家族补充上游许可声明和完整 MIT 标准条款，来源见 [记录](scripts/external-licenses/README.md)。库存完整不代表完成 Apple SDK 等发行复核。
