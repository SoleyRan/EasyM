# EasyM v0.2 设计与实施计划

基线：`feature/v0.2`，从 `develop` 的 `fcef6c3` 开始。日期：2026-10-10。

## 范围与不变约束

v0.2 是桌面预览阶段。原始 Markdown 仍是唯一正文；视图、查找、导出不能重写原文。复用 v0.1 的文档标签、格式命令、自动保存、草稿、图片副本与文件冲突保护。新增功能按下表分步验证，当前不代表整个 v0.2 已完成。

v0.1 仍有真实 IME、macOS/Linux 原生 GUI、发行签名和许可复核等验收缺口，继续保留原记录；开启 v0.2 开发不等于这些门槛已通过。v0.2 暂不加入账号、云同步、协作、DOCX、专用 PDF 引擎、版本历史或三方合并。

## 实施顺序

| 步骤 | 交付 | 验收 |
| --- | --- | --- |
| 1 文档内搜索 | 中文/Unicode 字面查找、大小写、整词、结果计数、循环定位、单次/全部替换 | 不修改正文的查询；替换单步撤销；选区与分屏定位正确；后台计数不使用过期范围；标签独立 |
| 2 即时渲染 | 同一个 CodeMirror 状态，非活动块呈现排版，活动块保留可编辑语法；先标题/行内，再代码/表格/图片 | 视图往返原文与撤销不变；鼠标任意选区、工具栏、中文组合、未知语法、大文档降级 |
| 3 工作区与大纲增强 | 工作区 Markdown 搜索、结果文件/行定位、按需加载与取消；文件树/大纲键盘操作 | 已授权目录范围、后台任务过期与取消、中文路径、外部文件变化、只读搜索 |
| 4 模板 | 内置空白/会议纪要/项目说明，变量仅作文本替换，生成新标签 | 不覆盖当前文件；新文档首次另存与草稿恢复；模板内容不执行脚本 |
| 5 HTML 与系统打印 | 安全静态 HTML、可移植本地图片、打印样式与系统打印入口 | 缺图提示；无脚本/网络图片加载；标题、表格、中文、分页；记录三平台打印差异 |
| 6 回归与开发包 | 更新说明、样例、证据、依赖许可；Windows 开发安装包；三平台关键路径 | v0.1 数据闭环持续通过；新功能测试与性能基线；未完成实机项明确记录 |

每步完成实现和针对性测试后记录状态，再进入下一步。默认视图暂维持源码；即时渲染通过技术验证后再讨论是否改默认。产品版本号在 v0.2 打包步骤统一调整，避免旧构建证据被误标为新版本。

## 第 1 步：文档内搜索契约

- 入口：编辑视图的“查找 / 替换”按钮、Ctrl/Cmd+F；F3/Ctrl/Cmd+G 下一项，Shift 反向；输入框 Enter 下一项、Shift+Enter 上一项；Esc 关闭并返回编辑器。
- 在当前标签的 Markdown 源文搜索，包含代码、链接地址、注释与未知语法；不是只搜索预览可见字。中文默认子串匹配；“整词”使用 CodeMirror 的 Unicode 词边界规则，不承诺中文语义分词。
- 本步仅字面搜索，不开放正则。`\n`、`$1`、反斜线等都是字面值，避免默认替换转义和捕获组意外修改文本。
- 上一项/下一项循环定位并选择源文范围，分屏同时定位预览；查询和选择不产生正文修改或自动保存。
- 单次替换只修改当前精确匹配选区；如果没有选中匹配，先定位，再次点击替换。全部替换基于命令执行时的编辑器状态；一次操作可撤销，图片/草稿/保存继续遵守已有规则。
- 每标签拥有独立搜索状态。关闭面板清除搜索高亮并保留查询，下次可继续；打开面板时如果源码中有不超过 100 字符的选区，用选中文字作为初始查询（CodeMirror 标准行为）。后台标签不向当前标签投递结果。
- 结果计数在 Worker 中执行并限制为 10,000 个匹配，超过上限显示“超过 10,000 项”，仍可逐项定位/替换，全部替换禁用。文档/条件变更立即使旧计数失效，120 ms 防抖后重算，返回仅接收当前请求的结果。
- 搜索输入支持中文组合；组合期间 Enter 不定位、替换命令不提交。计数失败时保留查询和源码，明确提示，禁用全部替换。
- 阅读模式本步沿用只读预览，不显示替换入口；第 2/3 步再评估跨视图统一查找。

## 进度

第 1 步已完成：`src/core/search.ts` 提供与 CodeMirror 一致的字面/Unicode 匹配和 10,000 条上限；`src/editor/search-panel.ts` 提供中文查找、大小写/整词选项、循环定位、单次/全部替换和独立标签查询；`src/platform/search-worker.ts` 在后台计数并丢弃过期请求。搜索替换使用现有撤销栈，不改变图片和自动保存契约。

第 1 步验证：`pnpm typecheck`、`pnpm test`（16 文件、93 测试，包含 5 项搜索契约）、`pnpm build`、`pnpm verify:workers`、`EASYM_TEST_BROWSER=msedge pnpm verify:browser`、`EASYM_TEST_BROWSER=msedge pnpm verify:writing`、`EASYM_TEST_BROWSER=msedge pnpm verify:search` 全部通过。搜索证据见 [v0.2 搜索验证](verification/v0.2-search-verification.json)。构建仍有原有大 chunk 提示，App 测试仍有非阻断的 React act 提示；真实输入法尚待原生验收。

新增 `@codemirror/search@6.5.11`（MIT），锁文件、Windows 第三方清单与 SBOM 已同步，407 个依赖版本的完整许可文本缺项为 0。Playwright Chromium 未安装时，Chromium 回归命令会报告运行时缺失；本机使用 Edge 完成回归。

## 第 2 步：即时渲染（实现完成）

即时渲染使用同一个 CodeMirror 实例和撤销栈，Markdown 源文始终保留。源码、分屏、即时渲染三种视图切换不会重建编辑器；普通标题、段落、行内强调、链接、列表和引用隐藏语法标记并保留原文选区，鼠标拖选时暂时冻结排版，释放后再显示活动源码范围。代码块、GFM 表格、独立图片和分隔线使用经过同一安全渲染器处理的块部件，点击或“源码”按钮可回到准确源范围；本地图片通过已授权资源生成对象 URL，远程图片不请求网络，图片单击选择、双击继续使用现有图片编辑事务。

即时渲染状态与文档 `Text` 身份绑定，正文修改立即清除旧块；过期 Worker 结果不会投递到当前标签。组合输入期间暂停展示并禁止视图/格式提交。正文超过 1 Mi 字符或单行超过 20,000 字符时降级为源码，缩短后自动恢复；单个块超过 100 KiB 不替换。前端 GFM 语法支持和预览渲染保持一致，未知 HTML、front matter、图片引用和未支持语法保持原样。

第 2 步验证：`pnpm typecheck`、`pnpm test`（18 文件、100 测试）、`pnpm build`、`pnpm verify:workers`、`pnpm verify:browser`、`pnpm verify:writing`、`pnpm verify:search`、`pnpm verify:performance` 以及 `EASYM_TEST_BROWSER=msedge pnpm verify:live` 全部通过。即时渲染证据见 [v0.2 即时渲染验证](verification/v0.2-live-preview-verification.json)，包含真实鼠标正反向选区、中文/emoji/软换行、格式切换和撤销、图片编辑、搜索替换、主题、未知语法安全性及大小限制。浏览器脚本另对组合事件做合成保护检查；真实 Windows IME 仍需原生验收。构建保留既有大 chunk 提示，App 测试保留非阻断 React act 提示。本机源码模式 5 MiB 文本/100 KiB 单行输入 p95 分别为 16.2/27.4 ms，未代替原生延迟验收。

本步骤没有原生 Rust 修改，未重复执行 Rust 测试或生成新的 Windows 安装包。默认仍是源码；独立行内图片保持源码形式，列表/引用等嵌套结构中的代码与表格暂保留语法，未扩展为可视表格单元格编辑器。下一步进入工作区搜索与文件树/大纲键盘操作。

## 第 3 步：工作区与大纲增强（实现完成）

工作区搜索只在用户授权的当前目录内执行，递归读取 `.md`/`.markdown`，忽略隐藏目录、`node_modules`、`target` 和符号链接。搜索在 Tauri 后台线程运行，查询、目录、文件、总读取量和结果数均有上限；单文件最多 2 MiB，总读取最多 64 MiB，结果最多 1000 条。结果携带相对路径、行号、预览片段和 SHA-256 revision，不修改原文件。

搜索请求带有独立 request id，可以取消；新查询、切换标签或卸载编辑器时取消旧任务，过期结果不会覆盖当前结果。打开结果时复用已有文档标签，重新校验文件 revision，并在源文中定位到匹配行；文件已外部变化或当前标签存在未保存编辑时，保留正文并提示重新搜索。搜索状态会显示扫描数、跳过数和是否达到限制。

文件树保持按需展开，支持方向键、Home/End、目录展开/收起和当前项滚动；大纲支持方向键导航，键盘移动不会误触发标题跳转。中文路径、BOM、CRLF、无效 UTF-8、NUL 字节、大文件、隐藏目录、取消和结果上限均有 Rust 契约测试；前端覆盖请求取消、过期结果、行定位、revision/脏正文保护、标签复用和键盘导航。

第 3 步验证：`pnpm.cmd typecheck`、`pnpm.cmd test`（19 个文件、106 项测试）、`pnpm.cmd build`、`pnpm.cmd verify:workers` 和 `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline`（19 项 Rust 测试）通过。Edge 的 `verify:browser`、`verify:search` 和新增 `verify:workspace` 通过。工作区生产界面使用确定性 IPC fixture 验证，真实文件系统行为由 Rust 测试覆盖；原生 WebView 的完整目录搜索仍待实机验收。证据见 [工作区验证](verification/v0.2-workspace-verification.json)，桌面/紧凑窗口截图保存在 `test-results/workspace-*.png`。生产构建仍保留既有大 chunk 提示。下一步进入内置模板。

## 第 4 步：内置模板（实现完成）

EM 菜单新增“从模板新建”，提供空白文档、会议纪要和项目说明三种模板。模板在独立新标签中生成，当前标签、撤销栈和工作区状态保持不变；模板对话框支持模板选择、标题和日期输入、Markdown 内容预览、Esc 取消、焦点循环和紧凑窗口布局。文件名只使用安全字符并限制长度，空标题回退为“未命名.md”。

模板变量只支持 `{{title}}` 和 `{{date}}`，使用一次性的字面文本替换，不执行 Markdown、HTML、脚本或模板表达式。生成正文继续通过已有源码编辑器、预览安全管线、自动草稿和另存为流程处理；空白模板保持干净，关闭不弹保存询问；有内容模板作为未保存草稿，刷新后可恢复，首次另存传入空磁盘身份并清除草稿。

本步骤已提交：`5b325c9 feat(templates): add built-in document templates`。

第 4 步验证：`pnpm.cmd typecheck`、`pnpm.cmd test`（20 个文件、112 项测试）、`pnpm.cmd build`、`pnpm.cmd verify:workers` 和 `EASYM_TEST_BROWSER=msedge pnpm.cmd verify:templates` 通过。模板 Edge 回归覆盖三种模板、中文/emoji/美元符号/嵌套占位符、脚本文本不执行、独立标签、空白文档关闭、草稿刷新恢复、浏览器下载、四种主题、焦点循环和紧凑布局。证据见 [模板验证](verification/v0.2-templates-verification.json)，截图保存在 `test-results/templates-*.png`。生产构建仍保留既有大 chunk 提示，App 测试有一个非阻断的 React act 提示。原生 Tauri 首次另存和 WebView 草稿重启仍需桌面实机验收。下一步进入安全 HTML 导出与系统打印。

## 第 5 步：HTML 与系统打印（实现完成，待原生实机验收）

本步骤已提交：`93c27ac feat(export): add safe HTML export and system printing`。

EM 菜单新增“导出 HTML”和“打印文档”，Ctrl/Cmd+P 也可打开打印预览。导出始终基于当前 Markdown 源文重新解析，不使用可能滞后的预览 Worker 结果，也不调用 Markdown 保存流程，因此不会改变文件身份、脏状态、撤销栈或草稿。HTML 是单文件静态文档，带严格的 `default-src 'none'` CSP 和内联排版/打印样式；继续复用安全 Markdown 渲染器，清理原始 HTML、危险链接和脚本。导出与打印准备期间阻止编辑、另存和关闭，失败或取消后保留当前文档。

本地 PNG/JPEG 通过已有授权的图片读取接口或草稿资源加载，转换为 `data:` URL 内联；资源读取按路径去重，总图片受 128 MiB 限制，单图仍受 20 MiB、图片头和尺寸校验限制，最终 HTML 上限 192 MiB。远程、绝对路径、越界路径、缺失或无法识别的图片不会请求网络，改为可见文字占位并提示缺图。桌面 HTML 导出使用独立保存对话框和临时文件原子写入，不加入 Markdown 文件会话，也不允许覆盖打开的文档或写入 Markdown 扩展名；浏览器模式下载 HTML。

打印先展示独立预览，等待图片解码、字体与布局准备后调用系统打印；预览保留到用户点击“返回编辑”或按 Esc。打印媒体只显示导出正文，隐藏编辑器、EM 菜单和侧栏，使用白底、表格重复表头、标题避免页末孤立、图片/表格行尽量不拆分和长代码换行规则。样式与当前编辑器主题独立；打印图片解码失败时提示并保留正文。

| 平台 | 系统入口及差异 | 本步验收状态 |
| --- | --- | --- |
| Windows | Tauri/WebView2 调用 `window.print()`；纸张、打印机、页眉页脚与 PDF 由 WebView2/系统 UI 设置 | Rust 编译/测试和 Edge 静态 HTML、打印媒体、PDF 分页已通过；原生保存对话框/打印机 UI 待实机验证 |
| macOS | Tauri/WKWebView 系统打印面板；当前 Wry 要求 macOS 11+ 打印 API，面板异步返回 | 待实机验证默认边距、字体替换、PDF 和取消行为 |
| Linux | Tauri/WebKitGTK/GTK PrintOperation 打印对话框，依赖系统打印后端 | 待实机验证打印机/PDF 选项、表头与分页 |

第 5 步验证：`pnpm.cmd typecheck`、`pnpm.cmd test`（22 个文件、120 项测试）、`pnpm.cmd build`、`pnpm.cmd verify:workers`、`cargo test --manifest-path src-tauri/Cargo.toml --locked --offline`（21 项 Rust 测试）、`EASYM_TEST_BROWSER=msedge pnpm.cmd verify:browser` 和 `EASYM_TEST_BROWSER=msedge pnpm.cmd verify:export` 通过。Edge 回归实际下载并打开独立 HTML，检查中文、代码高亮、表格边框、缺图占位、PNG 内联、无脚本/危险链接/网络请求、脏状态保持、Ctrl+P、Esc、打印媒体和 12 页 A4 PDF；浏览器打印调用使用 stub，不声称自动操作了原生系统打印面板。证据见 [HTML 与打印验证](verification/v0.2-export-verification.json)，截图和 PDF 保存在 `test-results/`。

本步没有新增依赖、版本号调整或安装包。下一步进入第 6 步：回归汇总、许可复核和 Windows 开发包，原生三平台打印与旧版验收缺口继续明确保留。

## 第 6 步：回归与开发包（本机收尾完成，待发行验收）

产品版本统一为 0.2.0，界面显示 `v0.2.0-dev`。新增统一串行回归 `verify:regression`，记录版本、生产入口哈希、各项结果与耗时，可添加 `--performance`。CI 使用统一入口上传功能报告；三平台桌面编译/测试、Windows disposable runner 安装/卸载继续保留，本轮尚未运行远程 CI。

本轮 `typecheck`、120 项前端单测、21 项 Windows Rust 单测、生产构建及 Edge 全量回归通过。5 MiB 正文/100 KiB 单行输入 p95 为 15.8/16.0 ms。Release 已编译，独立 WebView2 配置下原生窗口启动/正常关闭通过，Windows 0.2.0 NSIS 和带样例便携 ZIP 已生成；安装/卸载与原生功能验收没有因此自动通过。

许可生成器修复 Windows 文件名大小写与补充文本换行差异；新增精确字节哈希、链接、SBOM/来源验证和 Git 文件属性。Windows 407 个依赖版本、Linux 503 个文本缺项为 0；macOS 402 个仍缺 12 个，保留发行复核缺口。

新增中文 Markdown/PNG 体验样例与 [v0.2 验收与交付](Easy-Markdown-v0.2-验收与交付.md)，包含当前结果、限制、实机检查与执行方。新证据集中在 `Docs/verification/v0.2/`，旧版证据不覆盖；构建记录标明生成时的第 5 步 HEAD 加未提交工作区，并以源树/产物 SHA-256 关联。第 6 步改动与本记录一并提交，不 push。下一步为实机验收、远程 CI 与发行门槛复核，而非继续增加 v0.2 功能。
