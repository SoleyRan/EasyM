# EasyM v0.2 验收与交付

日期：2026-10-12。分支：`feature/v0.2`。产品版本：`0.2.0`，界面标识 `v0.2.0-dev`。

## 当前结论

6 步功能实现、自动化回归汇总和 Windows 开发包已完成。最终提交 `e66d0f7` 的远程 CI 已全部通过；当前仍是未签名开发候选，尚未达到三平台正式发行门槛。最新证据集中在 [acceptance-e66d0f7](verification/v0.2/acceptance-e66d0f7/acceptance-summary.json)。本机证据目录由验收脚本生成，包含构建与回归报告，不把浏览器 fixture 当作原生 GUI 验收。

v0.2 新增文档内查找/替换、即时渲染、工作区搜索及树/大纲键盘导航、内置模板、安全单文件 HTML 导出和系统打印入口。原始 Markdown 仍为唯一正文，默认打开源码视图；保存、草稿、图片副本、冲突保护继续沿用既有契约。具体范围见 [实施计划](Easy-Markdown-v0.2-设计与实施计划.md)。

## 最终验收（2026-10-12）

验收对象为 HEAD `e66d0f7`。本轮没有修改应用代码；新增验收记录及证据随本次文档提交归档。

| 检查 | 结果与证据 |
| --- | --- |
| 类型检查、前端单测、生产构建 | 通过，22 文件、125 项单测 |
| Windows Rust 单测 | 21 项通过，锁定依赖离线运行 |
| Chromium 生产回归 | 10 项通过，包含 Worker、图片/安全、选区/格式、查找、即时渲染、工作区、模板、导出、右键菜单及性能；[汇总](verification/v0.2/acceptance-e66d0f7/regression-verification.json) |
| 最终远程 CI | [run 38044000324](https://github.com/SoleyRan/EasyM/actions/runs/38044000324) 的前端、Windows、macOS、Linux 四个任务全部成功；[运行记录](verification/v0.2/acceptance-e66d0f7/ci-run.json) |
| CI 慢速初始化回归 | 6 倍 CPU 降速的 [查找](verification/v0.2/acceptance-e66d0f7/ci-browser/search-slow-verification.json) 与 [模板](verification/v0.2/acceptance-e66d0f7/ci-browser/templates-slow-verification.json) 均通过 |
| Windows 安装/启动/卸载 | 最终 CI 的 disposable runner 全部通过；[安装报告](verification/v0.2/acceptance-e66d0f7/ci-installer-verification.json) |
| 本机原生窗口 | 独立 WebView2 配置启动及正常关闭通过；[报告](verification/v0.2/acceptance-e66d0f7/native-startup-verification.json) |
| 许可与便携包 | Windows 407 个依赖、211 份许可文件、零缺项；ZIP 219 项及内嵌 exe 哈希校验通过 |
| HTML / 打印媒体 | 离线单文件 HTML、内联 PNG、中文、表格、代码、缺图提示及 12 页 A4 PDF 通过；[报告](verification/v0.2/acceptance-e66d0f7/export-verification.json)。系统打印调用仍用 stub |

本机 Chromium `156.0.8078.4`，5 MiB 文档打开 2124 ms、输入到下一帧 p95 17.8 ms；100 KiB 单行打开 140 ms、p95 26.8 ms，均低于 50 ms 目标。100 张本地图片恢复/解码 471 ms；20 MiB PNG 边界接受，多 1 字节拒绝。[性能报告](verification/v0.2/acceptance-e66d0f7/performance-verification.json) 的填充 PNG 不代表真实大图的内存压力，事件到下一帧指标也不能代替真实 IME。

最终 CI 浏览器与安装报告已下载并验证 ZIP SHA-256，摘要记录下载包 ID、哈希和任务结论。本机生产入口、现有 Release、NSIS 和便携包哈希与先前交付一致；本轮未重新编译 Release，便携 ZIP 重新打包并校验。126 项产物/锁文件哈希见 [构建记录](verification/v0.2/acceptance-e66d0f7/windows-build.json)。其中 `sourceDirty: true` 来自记录生成时新增的验收证据，测试开始时应用源代码与 HEAD 一致；本机包和 CI 包分别记录哈希，不混用。

原生 UI 工具可打开 EM 菜单、文件对话框并填入临时中文/空格路径；确认打开时返回 `coordinate input geometry is unavailable`，随后测试进程消失，窗口查询返回 `foreground window did not report a process id`。Windows Application 日志没有发现近期 EasyM 崩溃事件，原因未确认，文件打开结果不记为通过。测试使用独立配置与临时样例，保留为诊断；原生编辑、真实 IME 和原生对话框仍需实机确认。完整 [验收摘要](verification/v0.2/acceptance-e66d0f7/acceptance-summary.json) 明确区分已通过和未验证范围。

### 验收后重新打包（2026-10-12）

同一应用源码重新完成锁定依赖离线 Release 编译、NSIS 安装包和便携 ZIP。NSIS 下载超时后复用与官方哈希匹配的本地工具，通过临时 `useLocalToolsDir` 配置打包；便携包 219 项、许可与内嵌 exe 校验通过，[重新编译的原生启动/关闭检查](verification/v0.2/acceptance-e66d0f7/rebuilt-native-startup-verification.json) 通过。此次只验证构建、包内容和窗口启动/关闭，不扩展原生功能验收结论。

最新交付包 SHA-256 见 [重新打包记录](verification/v0.2/acceptance-e66d0f7/package-verification.json)。此前 `windows-build.json` 保留为重新打包前的验收证据，不能用于核对最新安装包。

## 第 6 步历史验证

后续 [CI run 38042888831](https://github.com/SoleyRan/EasyM/actions/runs/38042888831)（`524d312`）已通过查找、即时渲染、工作区和三平台桌面任务，但模板脚本第 55 行立即读取空白模板的标签名称，得到 `0 !== 1`。标签初次挂载后才由 `DocumentEditor` 的 effect 上报标题；现在先等待精确的 `空白草稿.md` 标签出现，再断言数量并测试无提示关闭。新增 `pnpm verify:templates --slow` 和失败时标签诊断/截图，保留完整断言；本机 Chromium 6 倍 CPU 降速模板流程已通过；最终远程 CI 也已通过，见上方最终验收。

| 检查 | 结果 | 证据/范围 |
| --- | --- | --- |
| TypeScript、前端单测、生产构建 | 通过；22 文件、120 项测试 | `pnpm.cmd typecheck`、`test`、`build` |
| Windows Rust 单测 | 通过；21 项 | `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline` |
| 统一 Edge 生产包回归 | 全部通过 | [汇总](verification/v0.2/regression-verification.json)：Worker、图片/安全、编辑选区、查找、即时渲染、工作区、模板、HTML/打印、性能 |
| Windows Release | 编译通过 | 锁定依赖离线构建；[构建哈希](verification/v0.2/windows-build.json) |
| Windows 原生窗口 | 启动、正常关闭通过 | [启动报告](verification/v0.2/native-startup-verification.json)，独立 WebView2 配置，不操作日常草稿 |
| HTML/打印媒体 | 独立 HTML、内联 PNG、中文、表格、代码、缺图及无网络请求通过 | [导出报告](verification/v0.2/export-verification.json)；实际生成 12 页 A4 PDF，系统打印调用用 stub，未操作原生打印面板 |
| 便携 ZIP | 219 项，必需资源与可执行文件哈希通过 | 包含样例、项目许可、Windows 清单/SBOM/来源及 211 份许可文件 |
| NSIS | 生成 0.2.0 x64 安装包 | 打包成功不等于安装/卸载验收通过 |

生产构建仍有既有大 chunk 提示；部分 App 单测有非阻断的 React act 提示。浏览器工作区/另存为测试使用受控 IPC fixture；真实文件系统契约由 Rust 单测覆盖，不代替原生 UI 验收。

统一入口为 `pnpm.cmd verify:regression --performance`，顺序执行并记录版本、生产入口哈希、每项结果与耗时；失败返回非零退出码。CI 已改为统一功能回归入口并上传报告，三平台桌面编译/测试与 disposable Windows 安装/卸载检查继续保留。此处是第 6 步历史记录；最终提交的远程 CI 状态见上方最终验收。

## 性能与降级

本机 Windows、Edge、Core 5 220H、约 32 GiB 内存；输入指标为事件到下一帧，不等于真实 IME 输入延迟。

| 场景 | 结果 |
| --- | --- |
| 5 MiB 正文 | 打开 2501 ms，输入 p95 15.8 ms |
| 100 KiB 单物理行 | 打开 154 ms，输入 p95 16.0 ms，源码高亮降级后正文/预览/撤销完整 |
| 100 张本地 800×600 图片 | 恢复并解码 451 ms，全部成功 |
| 20 MiB PNG 字节边界 | 39.5 ms 接受；多 1 字节 13.9 ms 拒绝；使用填充的 800×600 fixture，不代表 20 MiB 真实大图解码压力 |

详见 [性能报告](verification/v0.2/performance-verification.json)。即时渲染超过 1 Mi 字符或单行 20,000 字符时回退源码；单块超过 100 KiB 不替换。固定基准机、真实 WebView、大图内存与取消压力仍待复测。

## 开发包与样例

- 安装包：`src-tauri/target/release/bundle/nsis/EasyM_0.2.0_x64-setup.exe`。
- 便携包：`src-tauri/target/release/bundle/portable/EasyM-0.2.0-windows-x64-dev.zip`；解压运行 `easym.exe`，系统需 WebView2 Runtime。
- 源码样例：[体验指南](samples/v0.2/体验指南.md) 和 `assets/em.png`；便携 ZIP 同时带有 `samples/`，NSIS 只附带项目/第三方许可，样例从仓库取得。
- 包体、Release exe、前端产物、锁文件、许可清单哈希见 [构建记录](verification/v0.2/windows-build.json)。生成文件保留在已忽略的 `target/`、`test-results/` 中，不提交 Git。

复制整个样例目录到临时工作区，再在 EasyM 打开工作区与指南。原本存在的 PNG 应显示；缺图和远程图有意保留，导出/打印应提示占位。测试格式应用/取消、正反向拖选、撤销、搜索替换、四种主题和三种视图，再新建模板、另存、重启恢复。导出 HTML 后移到其他目录离线打开，图标应仍显示；Ctrl+P 检查打印预览与返回编辑。

## 依赖与许可

本轮没有新增依赖升级。SBOM 应用版本更新为 0.2.0，Windows 清单按当前锁文件重新生成。分平台 Cargo metadata 在本机筛选，只证明清单生成与文本完整性，不证明对应平台已编译运行。

| 目标 | 依赖版本数 | 完整许可文本缺项 |
| --- | ---: | ---: |
| Windows x86_64 MSVC | 407 | 0 |
| Linux x86_64 GNU | 503 | 0 |
| macOS aarch64 | 402 | 12 |

摘要见本目录对应 [Windows](verification/v0.2/dependency-inventory-windows.json)、[Linux](verification/v0.2/dependency-inventory-linux.json)、[macOS](verification/v0.2/dependency-inventory-macos.json)。生成器保留已存文件名大小写，补充文本按 LF 规范化后哈希；`.gitattributes` 禁止 Git 改写哈希命名许可文件的字节。`verify-notices.mjs` 校验版本、每个文件 SHA-256、精确大小写链接、来源和清单完整标记，防止 Windows 本地通过而 Linux checkout 失败。

macOS 的 block2、dispatch2、objc2 及框架包仍缺完整条款，上游声明和 Apple SDK 派生许可需要复核，不能使用通用 MIT 文本冒充补全。Windows/Linux 无缺项也不表示发行法律复核完成。

## 剩余验收与责任

| 项目 | 执行方 | 通过标准 |
| --- | --- | --- |
| Windows 真实输入法/选区 | 用户实机 | 用中文输入法组合、候选选择、回车；源码/即时渲染拖选任意文字，格式按钮应用/取消与撤销正确；组合不被工具栏打断 |
| Windows 原生文件与图片闭环 | 用户实机 | 中文/空格路径工作区搜索；模板首次另存与取消、自动保存、外部冲突副本、图片 recipe/剪贴板、草稿重启恢复均保留数据 |
| Windows 原生导出/打印 | 用户实机 | HTML 保存对话框取消不丢正文；离线 HTML 图片完整；原生打印/PDF 的分页、表头、长代码正确，返回编辑后撤销/主题正常 |
| macOS/Linux 原生 GUI | 有对应设备的用户/测试人员 | 文件/图片/草稿、真实 IME、搜索/模板、打印/PDF 和取消等关键路径通过，记录 OS/WebView 版本 |
| 发行签名与 macOS 许可复核 | 项目维护者提供身份/环境并复核 | 补完 macOS 条款，完成所需签名/公证和发行检查 |

已有 [v0.1 恢复与限制](Easy-Markdown-v0.1-已知限制.md) 中的数据恢复规则继续适用。即时渲染已启用，但不是全功能富文本编辑：独立行内图片、嵌套列表/引用内代码和表格、未知 HTML 等保留源码，不支持直接编辑表格单元格；远程图片、MDX、Mermaid 脚本不执行。搜索是字面匹配，整词不是中文分词；工作区搜索有单文件/总读取/结果上限。导出仅支持已授权的 PNG/JPEG，并有资源和产物总量上限；系统打印选项由 OS/WebView 提供。

完成上表剩余验收后，再决定发行标签和正式包；本次完成的是 v0.2 开发实现与本机交付收尾。
