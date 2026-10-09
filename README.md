# EasyM

EasyM 是一个本地优先的跨平台 Markdown 办公编辑器。v0.1 先实现可靠的桌面编辑闭环：Markdown 打开、编辑、保存、草稿恢复，以及图片导入后只修改当前插入实例的副本。

## 当前状态

已建立 React + TypeScript + Vite 前端和 Tauri 2 桌面工程，当前实现包括：

- 源码与分屏视图，即时渲染保留待验证入口；
- 顶部文件操作、按需展开文件树/大纲，分屏源码滚动同步预览；
- 代码块语言选择、语言修改撤销/重做和清晰的代码块配色；
- Markdown 源范围补丁、工具栏命令、标题大纲；
- 本地草稿自动保存、未应用图片操作恢复和显式保存状态；
- PNG/JPEG 导入、后台处理、裁剪/旋转/翻转/尺寸/Alt、取消和应用；
- 图片源副本、显示副本、实例隔离和浏览器工作区 ZIP 下载；
- IndexedDB 草稿恢复、UTF-8/BOM/LF/CRLF 保留、外部版本重新加载入口；
- 文档核心、图片契约和 ZIP 路径安全单元测试；
- Tauri 2 原生文件保存、冲突检查、图片资源事务和 `.easym/images.json` 实现；
- 窗口关闭保护：返回编辑、保留草稿并退出、保存并退出；
- 保存操作日志与中断恢复、后台 Markdown 解析 Worker。
- 桌面工作区目录选择、延迟加载文件树和树内图片拖入；
- Windows 复制图片文件后粘贴的原生兼容路径，以及失焦时刷新草稿。

浏览器模式用于验证编辑和图片闭环，保存会下载 Markdown 或工作区 ZIP。2026-10-09 已通过 TypeScript 检查、49 项前端测试、15 项 Windows Rust 测试、生产 Worker 检查和 Edge 生产包回归（真实像素/EXIF、图片实例隔离、IndexedDB 草稿恢复、代码语言和分屏滚动），并生成 Windows Release 可执行文件。Windows 原生交互与 macOS/Linux 关键路径仍待验收，当前尚未达到 v0.1 发布门槛。即时渲染视图保持禁用，源码和分屏是当前稳定路径。设计冻结见 [Docs/Easy-Markdown-v0.1-设计冻结.md](Docs/Easy-Markdown-v0.1-设计冻结.md)，实现与验收状态见 [Docs/Easy-Markdown-v0.1-实现说明.md](Docs/Easy-Markdown-v0.1-实现说明.md)。

## 开发

使用 Node.js 22+，pnpm 版本由 `package.json` 的 `packageManager` 字段锁定：

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm verify:workers
pnpm exec playwright install chromium
pnpm verify:browser
pnpm verify:writing
pnpm verify:performance
```

安装 Rust、系统 WebView 和 Tauri 依赖后，可以运行：

```bash
pnpm desktop:dev
pnpm desktop:build
```

Windows PowerShell 若拦截 `.ps1` 启动脚本，使用 `pnpm.cmd`。应用图标已包含在项目中，SVG 源文件位于 `src-tauri/icons/app-icon.svg`；修改后运行 `pnpm.cmd icons` 重新生成各平台图标。

已有 Microsoft Edge 时，PowerShell 可设置 `$env:EASYM_TEST_BROWSER = 'msedge'`，使用它运行浏览器检查，无需另装 Chromium。检查会创建独立的无头浏览器配置，不读取日常浏览器或桌面应用的草稿。性能脚本的事件到下一帧延迟仅作本机基线，不能代替真实 WebView/输入法验收。报告输出在 `test-results/`。

Windows Release 可执行文件位于 `src-tauri/target/release/easym.exe`。附带项目与第三方许可的便携包位于 `src-tauri/target/release/bundle/portable/EasyM-0.1.0-windows-x64-dev.zip`，解压后运行 `easym.exe`；系统需要已安装 WebView2 Runtime。它是未签名的开发候选包，运行验收状态见 [验收记录](Docs/Easy-Markdown-v0.1-验收记录.md)，构建校验值见 [windows-build.json](Docs/verification/windows-build.json)。

Windows 安装包已生成：`src-tauri/target/release/bundle/nsis/Easy Markdown_0.1.0_x64-setup.exe`（未签名开发候选，尚未验证安装/卸载）。首次打包需要从 GitHub 下载 WiX/NSIS；2026-10-09 重试下载成功并通过官方哈希校验，使用项目内工具缓存完成 NSIS 打包。只需生成可执行文件时可运行 `pnpm.cmd tauri build --no-bundle`。

## 许可

项目代码采用 Apache-2.0，完整条款见 [LICENSE](LICENSE)。

第三方依赖清单、许可文本和 Windows 依赖 SBOM 见 [Docs/dependencies/THIRD-PARTY-NOTICES.md](Docs/dependencies/THIRD-PARTY-NOTICES.md)。其他平台的发行依赖清单仍需在对应构建环境生成。
