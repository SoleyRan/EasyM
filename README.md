# EasyM

EasyM 是一个本地优先的跨平台 Markdown 办公编辑器。v0.1 先实现可靠的桌面编辑闭环：Markdown 打开、编辑、保存、草稿恢复，以及图片导入后只修改当前插入实例的副本。

## 当前状态

当前为 `feature/v0.2` 的 0.2.0 开发候选，6 步实现与本机自动化收尾已完成：文档内查找/替换、即时渲染、工作区搜索/键盘导航、内置模板、安全 HTML 导出与系统打印入口，以及统一回归和 Windows 开发包。范围见 [v0.2 设计与实施计划](Docs/Easy-Markdown-v0.2-设计与实施计划.md)，结果与待验收项见 [v0.2 验收与交付](Docs/Easy-Markdown-v0.2-验收与交付.md)。原生三平台关键路径和本轮远程 CI 尚未完成，当前不是正式发行版。

已建立 React + TypeScript + Vite 前端和 Tauri 2 桌面工程，当前实现包括：

- 源码、分屏与即时渲染视图；即时渲染在同一编辑器中呈现标题/行内格式、代码、表格、图片和分隔线，活动块保留源码可编辑；
- EM 图标文件菜单、右侧多文档标签与滚轮浏览，按需展开并拖拽调整文件树/大纲宽度；
- 分屏源码与预览双向滚动同步，点击大纲标题同步定位两侧；
- 代码块语言选择及源码/预览语法高亮、语言修改撤销/重做；
- 多文档标签，各自保留正文、撤销记录、滚动位置和草稿；
- 四种 Style 配色（浅色、深色、暖纸、护眼绿），点击 EM 菜单中的 Style，在右侧子菜单选择并自动记住；
- 随主题变化的顶栏窗口控制、拖动与双击最大化；底部行数与字数；
- 全屏阅读模式：仅显示预览，支持文件树/大纲、按钮或 Esc 退出，保留正文和撤销记录；
- Markdown 源范围补丁、可隐藏且记住偏好的格式工具栏、标题大纲与带边框表格；
- 文档内查找/替换入口，支持中文/Unicode 查询、结果计数、循环定位和可撤销替换；
- EM 菜单内置空白、会议纪要和项目说明模板，支持变量字面替换、独立新标签、草稿恢复和首次另存；
- EM 菜单导出单文件静态 HTML，内联已授权本地 PNG/JPEG，远程/缺失图片提示占位；打印预览、Ctrl/Cmd+P 和系统打印入口，输出不改变 Markdown 或草稿；
- 格式工具栏应用/取消切换、选区按下/混合状态，以及主题适配的鼠标选区高亮；
- 已命名本地文档停止输入 1.2 秒后自动保存，草稿与未应用图片操作恢复；
- PNG/JPEG 导入、后台处理、裁剪/旋转/翻转/尺寸/Alt、取消和应用；
- 图片源副本、显示副本、实例隔离和浏览器工作区 ZIP 下载；
- IndexedDB 草稿恢复、UTF-8/BOM/LF/CRLF 保留、外部版本重新加载入口；
- 文档核心、图片契约和 ZIP 路径安全单元测试；
- Tauri 2 原生文件保存、冲突检查、图片资源事务和 `.easym/images.json` 实现；
- 标签/窗口关闭保护：返回编辑、不保存关闭/退出、保留草稿、保存后关闭；
- 保存操作日志与中断恢复、后台 Markdown 解析 Worker。
- 桌面工作区目录选择、延迟加载文件树和树内图片拖入；
- Windows 复制图片文件后粘贴的原生兼容路径，以及失焦时刷新草稿。

浏览器模式用于验证编辑和图片闭环，保存会下载 Markdown 或工作区 ZIP。2026-10-10 的 v0.2 已通过 TypeScript 检查、120 项前端测试、21 项 Windows Rust 测试、生产 Worker 和 Edge 全量回归，以及 Windows Release 编译、原生窗口启动/正常关闭检查。本机 5 MiB 文本和 100 KiB 单行输入 p95 分别为 15.8/16.0 ms。超长行超过 20,000 字符时暂停源码高亮，缩短后自动恢复，正文和预览保持完整。v0.1 的原生另存、自动保存、阅读/Esc、草稿重启和三平台 CI 是历史证据，不能替代本轮验收；完整 Windows 图片/真实输入法、macOS/Linux GUI 和发行复核仍待完成。设计冻结见 [v0.1 设计](Docs/Easy-Markdown-v0.1-设计冻结.md)，旧版实现记录见 [v0.1 实现说明](Docs/Easy-Markdown-v0.1-实现说明.md)。

本地文件在停止输入 1.2 秒后自动写回；新建或恢复文档先自动保留草稿，首次从 EM 菜单另存为。外部冲突、写入失败或混合换行转换会暂停自动写回并提示，Ctrl/Cmd+S 可手动保存。文件树展开后打开文档仍保持显示，“格式工具栏”按钮可隐藏/显示格式按钮并记住选择；预览表格在四种主题下均有边框。即时渲染在超出 1 Mi 字符或 20,000 字符单行时明确降级为源码。

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
pnpm verify:search
pnpm verify:live
pnpm verify:workspace
pnpm verify:templates
pnpm verify:export
pnpm verify:performance
```

构建后可用 `pnpm verify:regression` 串行执行全部功能回归，添加 `--performance` 同时测量性能。CI 使用统一入口，性能数据在本机单独记录；各项命令仍可独立运行。依赖清单生成后运行 `node scripts/verify-notices.mjs`，核验 SBOM 版本、许可文件字节哈希、链接大小写和补充文本来源。

安装 Rust、系统 WebView 和 Tauri 依赖后，可以运行：

```bash
pnpm desktop:dev
pnpm desktop:build
```

Windows PowerShell 若拦截 `.ps1` 启动脚本，使用 `pnpm.cmd`。应用图标已包含在项目中，SVG 源文件位于 `src-tauri/icons/app-icon.svg`；修改后运行 `pnpm.cmd icons` 重新生成各平台图标。

已有 Microsoft Edge 时，PowerShell 可设置 `$env:EASYM_TEST_BROWSER = 'msedge'`，使用它运行浏览器检查，无需另装 Chromium。检查会创建独立的无头浏览器配置，不读取日常浏览器或桌面应用的草稿。性能脚本的事件到下一帧延迟仅作本机基线，不能代替真实 WebView/输入法验收。报告输出在 `test-results/`。

Windows Release 可执行文件位于 `src-tauri/target/release/easym.exe`。便携包位于 `src-tauri/target/release/bundle/portable/EasyM-0.2.0-windows-x64-dev.zip`，附带项目许可、第三方许可和 `samples/体验指南.md`，解压后运行 `easym.exe`；系统需要 WebView2 Runtime。它是未签名的开发候选包，验收状态见 [v0.2 验收与交付](Docs/Easy-Markdown-v0.2-验收与交付.md)，校验值见 [v0.2 构建记录](Docs/verification/v0.2/windows-build.json)。

Windows 安装包已生成：`src-tauri/target/release/bundle/nsis/EasyM_0.2.0_x64-setup.exe`（附带项目与第三方许可，未签名；安装/卸载待本轮 CI）。CI 的安装/启动/卸载脚本仅在 disposable Windows runner 执行。应用名称为 EasyM，图标为 EM。首次打包需要下载 WiX/NSIS，本机复用已校验的缓存工具。只生成可执行文件可运行 `pnpm.cmd tauri build --no-bundle`；便携 ZIP 使用 `./scripts/package-portable.ps1`。`./scripts/verify-native-startup.ps1` 以独立 WebView2 配置验证 Release 窗口启动与关闭；完成回归和打包后运行 `node scripts/record-build.mjs Docs/verification/v0.2` 记录证据。

## 许可

项目代码采用 Apache-2.0，完整条款见 [LICENSE](LICENSE)。

第三方依赖清单、许可文本和 Windows 依赖 SBOM 见 [第三方清单](Docs/dependencies/THIRD-PARTY-NOTICES.md)。CI 按目标平台重新生成并上传；Windows/Linux 文本缺项为 0，macOS 的 12 个 objc2 家族包仍需补完整文本及发行复核，当前分平台摘要见 `Docs/verification/v0.2/dependency-inventory-*.json`。许可文件按原始字节存储，Git 不转换其换行。当前功能限制见 [v0.2 验收与交付](Docs/Easy-Markdown-v0.2-验收与交付.md)，既有数据恢复规则见 [v0.1 已知限制](Docs/Easy-Markdown-v0.1-已知限制.md)。
