# EasyM v0.2 验收与交付

日期：2026-10-10。分支：`feature/v0.2`。产品版本：`0.2.0`，界面标识 `v0.2.0-dev`。

## 当前结论

6 步功能实现、自动化回归汇总和 Windows 开发包已完成。当前为未签名开发候选，尚未达到三平台正式发行门槛。第 5 步提交为 `93c27ac feat(export): add safe HTML export and system printing`；第 6 步证据使用该 HEAD 加工作区改动生成，`windows-build.json` 中 `sourceDirty: true`，并记录源树哈希。不会把旧版 CI 或浏览器测试标为本轮原生验收。

v0.2 新增文档内查找/替换、即时渲染、工作区搜索及树/大纲键盘导航、内置模板、安全单文件 HTML 导出和系统打印入口。原始 Markdown 仍为唯一正文，默认打开源码视图；保存、草稿、图片副本、冲突保护继续沿用既有契约。具体范围见 [实施计划](Easy-Markdown-v0.2-设计与实施计划.md)。

## 本轮验证

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

统一入口为 `pnpm.cmd verify:regression --performance`，顺序执行并记录版本、生产入口哈希、每项结果与耗时；失败返回非零退出码。CI 已改为统一功能回归入口并上传报告，三平台桌面编译/测试与 disposable Windows 安装/卸载检查继续保留。本轮尚未 push，也未运行更新后的远程 CI。

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
| 本轮三平台 CI | 后续提交/push 后自动执行 | 前端统一回归、三平台 Rust/构建和 Windows 安装/启动/卸载均成功，按实际 commit 记录新证据 |
| macOS/Linux 原生 GUI | 有对应设备的用户/测试人员 | 文件/图片/草稿、真实 IME、搜索/模板、打印/PDF 和取消等关键路径通过，记录 OS/WebView 版本 |
| 发行签名与 macOS 许可复核 | 项目维护者提供身份/环境并复核 | 补完 macOS 条款，完成所需签名/公证和发行检查 |

已有 [v0.1 恢复与限制](Easy-Markdown-v0.1-已知限制.md) 中的数据恢复规则继续适用。即时渲染已启用，但不是全功能富文本编辑：独立行内图片、嵌套列表/引用内代码和表格、未知 HTML 等保留源码，不支持直接编辑表格单元格；远程图片、MDX、Mermaid 脚本不执行。搜索是字面匹配，整词不是中文分词；工作区搜索有单文件/总读取/结果上限。导出仅支持已授权的 PNG/JPEG，并有资源和产物总量上限；系统打印选项由 OS/WebView 提供。

完成上表剩余验收后，再决定发行标签和正式包；本次完成的是 v0.2 开发实现与本机交付收尾。
