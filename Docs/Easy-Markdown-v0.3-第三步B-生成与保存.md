# v0.3 第三步 B：DOCX 生成与保存

本步承接已提交的 3A（`fc05a86 feat(docx): add export model and resource preflight`），完成完整模型到 OOXML、后台任务与独立保存接口。尚未接入应用菜单；3C 接入界面并验收真实办公软件。应用与历史安装包版本继续为 0.2.0。本步没有生成新的安装包。

## 完整生成

`src/core/docx.ts` 从预检模型生成可编辑段落、六级标题、嵌套粗斜体/删除线/行内代码、安全链接、显式换行、引用、编号/无序/任务列表、原生表格、分隔线、代码与静态原文。冻结办公样例全部文本已逐项比对 OOXML；未知 HTML/front matter 和未使用定义仍保留为静态文字。导出不依赖应用主题，不保存原 Markdown，也不改写资源。

- A4/Letter、四边 20 mm。正文 11 pt，标题递减，代码 9 pt；默认/紧凑两种办公样式，黑字、浅色代码和表头。使用 Calibri/Microsoft YaHei/Consolas 等字体名称，不嵌入字体。
- 标题保留级别和 keep-next，包括列表内标题。编号保留起始值、独立列表重新开始；支持 9 层原生编号，更深使用静态标记，深层缩进限定在内容宽度的一半。任务使用静态 ☑/☐。
- 表格保持行列、列对齐、可见边框和重复首行。普通行尽量同页；总文本较长或有图片的单元格允许行拆分，长代码保留空格和换行并允许跨页。代码语言为静态标签，不包含应用语法高亮颜色。
- 图片使用当前显示资源的 PNG/JPEG 原字节、保留 alt，按 96 dpi 同比例适配正文/单元格宽度和页面高度，不主动放大。相同字节资源去重。失效图片默认阻止生成，显式占位才保留图片说明继续；占位不能绕过尺寸/资源配额。

原生 Word/WPS/LibreOffice 的编辑性、分页、字形回退和极端表格宽度仍需 3C 实际打开检查。OOXML 结构正确不等于三种软件排版一致。

## 平台接口与取消

`src/platform/docx.ts` 提供三个接口：

1. `preflightDocx({ text, name, id, resources }, signal)`：从当前内存文本解析模型，快照当前文档身份及内存资源，再串行读取/完整解码图片，返回模型与独立字节集合。
2. `renderDocx(prepared, options, signal)`：Worker 生成 DOCX，返回 ArrayBuffer。克隆传入资源，不转移掉预检的字节，失败后仍能重试。
3. `saveDocx(name, bytes, signal)`：浏览器下载；桌面调用独立 `export_docx` 原生另存对话框，取消返回 false。派发前可由 signal 取消，派发后的对话框/写入由原生端管理，界面不能宣称仍可中止已提交的写入。

解析和生成分别最多 60 秒；资源读取和完整图片解码每项最多 15 秒。Worker 在成功、错误、取消和超时后均退出并移除监听器。Tauri 图片 IPC 无法中断已经开始的后端读取；前端取消会立刻结束等待、丢弃迟到结果，并停止后续资源读取。原生配额、资源超时与取消均为硬失败，不转为“缺图”占位。

资源仅来自当前文档的内存 Blob，或现有文档授权 ID 下的安全本地相对图片路径；不 fetch 远程 URL、不读取任意路径，也不读取原始图片历史副本来替代当前显示版本。平台预检通过 `createImageBitmap` 完整解码并关闭 bitmap，头部合法但像素损坏的图片会报告无效。核心资源函数的注入解码器用于测试；后续界面使用平台接口。

## 原生安全保存

`src-tauri/src/export.rs` 的 `export_docx(name, bytes)` 只接收文件名和二进制内容，输出路径由原生对话框授权，导出文件不加入 Markdown 会话。

- 限制 `.docx` 与 192 MiB 输出。锁定 zip 6.0.0，仅启用 DEFLATE；复用 quick-xml 0.42.0，验证全部条目 CRC、必要 OOXML 项、根命名空间、XML 完整性和 main content type，拒绝 DTD/宏/OLE/远程图片关系及危险条目路径。
- 解压总量最多 192 MiB、条目 4096、XML 深度 128，防止恶意归档解压耗尽资源。
- 拒绝目录、符号链接/Windows reparse 目标，以及打开的文档和它们的硬链接（same-file 1.0.6）。
- 对话框返回时记录目标版本。同目录临时文件写入、同步后复核 SHA-256，发现外部版本变化或新目标竞争返回冲突；原文件保留，临时文件自动清理。新目标使用 persist_noclobber，已有目标原子替换。
- 不承诺任意外部进程的文件锁：已有目标的最终复核和原子替换之间仍有极短竞争窗口。授权对话框覆写、取消和受占用文件行为在 3C 的实机验证中确认。

Windows 依赖清单/SBOM 已同步：430 个依赖版本、234 个许可文本文件全部散列通过，缺失文本为 0。其他平台仍由 CI 按目标生成；原有 macOS 许可缺口保留。

## 验证与复现

`pnpm.cmd verify:docx` 构建独立验收入口，但使用真实平台接口、相同 Vite 配置、内联 Worker 和应用 CSP；并非用另一份示例生成器替代产品实现。它验证冻结办公样例、损坏图片、占位、硬配额、解析/解码/生成取消、超时、Worker 退出、源/预检不变、浏览器下载字节和无远程请求。超时测试把计时器缩短到 30 ms，并注入不响应的 Worker，实际走 60 秒超时分支。

| 检查 | 结果 |
| --- | --- |
| 前端类型检查 / 生产构建 | 通过；构建仍有原有大 chunk 提示 |
| 前端单测 | 全量 25 个文件、146 项通过；生成器/平台针对性检查也通过 |
| Rust `cargo test --locked` | 27 项通过；含新旧目标竞争、写入失败、打开文件/硬链接保护、损坏 ZIP/XML、真实生成文件保存 |
| DOCX 浏览器验收 | 10 组检查通过；Chromium 156.0.8078.4，16 个 Worker 全部退出 |
| 统一 `verify:regression` | 11 项全通过，包含 DOCX 及原有全部功能检查 |
| 严格许可生成与散列核验 | 通过，Windows 缺失文本 0 |
| Git diff 格式检查 | 通过 |

单测有既有 React act 提示。一轮并行构建/单测期间的既有浏览器草稿恢复检查曾超时；随后停止并行构建、串行完整复核。构建与回归应串行，避免 dist 在页面加载过程中被替换。验收入口输出在忽略目录 `test-results/docx/`，记录见 [3B 验证数据](verification/v0.3-step3b-verification.json)。Rust 的真实文件联调测试只有设置 fixture 才执行内容核验，本次已实际设置：

```powershell
pnpm.cmd verify:docx
$env:EASYM_DOCX_FIXTURE = (Resolve-Path 'test-results/docx/office.docx').Path
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

本步不声称完成菜单、编辑保护、焦点恢复、草稿/dirty/撤销 UI 闭环、原生对话框实机检查或 Word/WPS/LibreOffice 排版验收。3C 按冻结计划完成这些事项，并测量内存峰值与较大样例性能。
