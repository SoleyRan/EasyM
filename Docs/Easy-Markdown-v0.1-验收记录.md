# Easy Markdown v0.1 验收记录

记录日期：2026-10-09。当前结论：开发候选构建可运行，自动化闭环通过，尚未达到冻结文档第 12 节的三平台完成判定。

## 自动化证据

| 项目 | 当前结果 | 证据/复现入口 |
| --- | --- | --- |
| TypeScript 与前端单测 | 通过，49 项 / 13 文件 | `pnpm.cmd typecheck`、`pnpm.cmd test` |
| Windows Rust 单测 | 通过，15 项 | `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline` |
| Release 构建 | Windows MSVC 成功 | `pnpm.cmd tauri build --no-bundle`；校验值见 [windows-build.json](verification/windows-build.json) |
| Windows 便携交付 | 已生成开发候选 ZIP，含程序与许可 | `src-tauri/target/release/bundle/portable/EasyM-0.1.0-windows-x64-dev.zip`；210 个条目，无重复与越界路径，内嵌 exe 哈希与独立产物一致 |
| Windows NSIS 打包 | 成功，未签名，安装/卸载未验证 | `src-tauri/target/release/bundle/nsis/Easy Markdown_0.1.0_x64-setup.exe`；校验值见 [windows-build.json](verification/windows-build.json) |
| 无 DOM Worker 初始化 | 通过，检查实际打包代码 | `pnpm.cmd verify:workers` |
| 生产浏览器闭环 | 通过，使用与 Tauri 相同的 CSP | `pnpm.cmd verify:browser`；[报告](verification/browser-verification.json) |
| 写作体验回归 | 通过，配色、代码语言、分屏滚动、布局 | `pnpm.cmd verify:writing`；[报告](verification/writing-verification.json) |
| 输入与资源性能样例 | 四组完成，本机文本输入目标通过 | `pnpm.cmd verify:performance`；[报告](verification/performance-verification.json) |
| 依赖交付 | Windows 清单 373 个版本，许可文本完整 | [第三方清单](dependencies/THIRD-PARTY-NOTICES.md)、[SBOM](dependencies/sbom.cdx.json) |
| 三平台 CI | 配置完成，未远程执行 | `.github/workflows/ci.yml` |

浏览器回归覆盖真实像素、PNG 裁剪/旋转/翻转/缩放、JPEG EXIF 八方向及二次归一化、透明与白底、无效图片拒绝、中文/emoji 正文、两张图片实例隔离、应用/取消/撤销/重做，以及 IndexedDB 正文/资源/未应用操作在页面重载后的恢复。中文文本录入不等同于中文输入法组合验证。

Rust 故障注入覆盖外部版本冲突、资源写入中再次变化、正文提交前失败重试、正文提交后元数据恢复、恢复时保留后续外部版本、源副本不可变、元数据损坏/高版本保护和目录授权边界。

本次写作回归验证代码块内部背景透明且文字继承浅色，行内代码仍有浅底；语言标记插入/修改/清除支持撤销重做；源码滚动事件驱动预览，中段可见标题差不超过一节，顶部与底部对齐；调整窗口和新建文档后保持有效。默认隐藏两侧面板时，1440/960×900 的内容区域宽度至少为窗口的 96%，高度大于 650px。无头浏览器的滚动条可能隐藏，因此鼠标拖动后也直接调整 scrollTop 验证实际 scroll 事件；尚不等同于原生 WebView2 滚动条手工验收。

## 本机性能基线

Edge 154.0.4258.62，无头模式，1440×900；Windows 10.0.26200、Core 5 220H、16 逻辑核、31.7 GiB 内存。正文用真实文件选择器打开；输入各采集 40 次 `a` 按键，按 keydown 到下一 requestAnimationFrame 统计 p95。这是本机 UI 延迟近似值，包含 CodeMirror/React 更新，不能替代物理显示、输入法或 WebView2 的测量。

| 样例 | 结果 |
| --- | --- |
| 5 MiB 多段 Markdown | 打开 2,293 ms；输入 p95 16.7 ms |
| 100 KiB 超长单行 | 打开 111 ms；输入 p95 23.8 ms |
| 100 张 800×600 本地 PNG | 恢复并解码 387 ms，100 张均完成 |
| 20 MiB PNG 字节边界 | 接受（54.9 ms），多 1 字节拒绝（14.4 ms） |

20 MiB 样例为有效 800×600 PNG 加尾部填充，用于确定字节边界，不能证明高熵大图或接近 2400 万像素的内存峰值。两组输入在这台机器上满足 50 ms 目标；发布前仍需固定基准机、三平台 WebView 与真实图片内存/取消压力复测。该脚本不在 CI 中断言时间，以免不同硬件制造不可靠的门槛。

最初与 Release 编译并行运行时存在 CPU 竞争，5 MiB 打开耗时达到 9,106 ms；编译结束后重测得到上表结果，归档报告使用重测值。

## 桌面验收与待办

便携包解压后运行 `easym.exe`，依赖系统 WebView2 Runtime，未签名、未安装到系统。程序、Apache-2.0 条款、第三方清单、CycloneDX SBOM 与 205 份许可文件一并交付。ZIP SHA-256：`37b4828b4052e5295158c6bf7680c98287a961de559d7800000ca4ba4e634d0b`。本轮重新生成便携包并验证全部 210 个条目和内嵌程序哈希。

NSIS 首次下载曾停滞/超时，2026-10-09 再次下载成功。工具 ZIP 与插件分别通过当前 Tauri CLI 2.12.1 官方源码指定的 SHA-1 校验（`EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D`、`75197FEE3C6A814FE035788D1C34EAD39349B860`）。工具缓存放在 `src-tauri/target/.tauri/NSIS`，以临时配置 `bundle.useLocalToolsDir=true` 执行 `pnpm.cmd tauri bundle --bundles nsis --no-binary-patching --config test-results/nsis-local.config.json`，复用既有 Release 程序完成打包，独立 exe 哈希不变。

写作修正后的安装包为 2,532,931 bytes，SHA-256 `26c403f3e35a69574b0575e91fb1ecd8734fa444cb920ec0f75c62dc7191167b`。生成的 NSIS 脚本已核对包含项目 LICENSE、第三方清单、SBOM 和许可资源；未执行安装/卸载，未进行代码签名。

独立 Windows Release 测试实例曾启动；原有用户进程与草稿未触碰。Computer Use 应用访问审批超时，未能取得窗口状态，故原生交互没有记作通过。该测试实例随后清理；编译成功和浏览器通过均不能代替桌面验收。

以下场景应在新建的临时工作区执行，记录平台、应用校验值、输入法和结果。每个失败项需附可复现步骤，不能以重置草稿消除故障。

| 场景 | 预期结果 | Windows | macOS | Linux |
| --- | --- | --- | --- | --- |
| 新建/打开/另存，含中文、空格路径 | 系统选择器正常；取消保留正文 | 待验收 | 待验收 | 待验收 |
| 未编辑 UTF-8/BOM、LF/CRLF 文件保存 | 字节不变；混合换行编辑明确询问 | 待验收 | 待验收 | 待验收 |
| 中文组合输入与 Ctrl/Cmd 快捷键 | 不破坏组合；源码/分屏共享正文 | 待验收 | 待验收 | 待验收 |
| 文件树打开文档/拖图片、截图粘贴、文件粘贴 | 导入副本；普通文本粘贴正常 | 待验收 | 待验收 | 待验收 |
| 同图插入两次，双击裁剪、取消、应用、撤销 | 原图不变；另一实例不变 | 待验收 | 待验收 | 待验收 |
| 关闭返回编辑、保留草稿退出、保存退出 | 仅成功保存/刷盘后关闭 | 待验收 | 待验收 | 待验收 |
| 未应用图片 recipe，退出后进程重启恢复 | 正文、源副本、Alt 与操作完整恢复 | 待验收 | 待验收 | 待验收 |
| 外部修改、保存取消/无权限、损坏元数据 | 不覆盖任何版本；失败保留窗口 | 待验收 | 待验收 | 待验收 |
| 中断保存后重启，随后又有外部修改 | 恢复仅补元数据，不重写外部正文 | 待验收 | 待验收 | 待验收 |
| 高 DPI、键盘焦点、屏幕阅读器、长路径 | 中央编辑区和图片面板可使用 | 待验收 | 待验收 | 待验收 |

安装包安装/卸载、代码签名、平台专用依赖清单与许可分发仍属于发行验收。当前即时渲染按冻结文档允许的降级路径保持禁用，默认源码、分屏可用；历史资源/操作日志自动清理、多文档标签和完整富文本编辑不纳入当前交付。
