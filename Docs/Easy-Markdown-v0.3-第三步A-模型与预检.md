# v0.3 第三步 A：DOCX 模型与预检

验证日期：2026-10-12。分支：`feature/v0.3`，起点提交：`9a559b3`。本步完成共享原始 AST、DOCX 中间模型、资源预检和生成库可用性验证。应用仍为 0.2.0，尚未提供“导出 DOCX”菜单；测试用文件不代表产品完整导出已交付。

## 实现

- `src/core/markdown-ast.ts` 提供独立原始 AST。预览与导出各自解析，不共享被预览改写的图片节点；源范围保留中文/emoji 的 UTF-16 offset。现有预览渲染与消毒处理继续使用原流程。
- `src/core/docx-model.ts` 将标题、段落、行内样式、链接、引用、列表/任务、代码、表格、图片和分隔线映射为可序列化模型。未知节点、HTML、front matter 保留原文；第一条引用定义用于解析，未使用/被后续重复遮蔽的定义作为原文附录保留。
- 预检记录中文说明、代码、源范围和资源，详细警告最多 1000 条，同时独立记录总数和缺图总数。危险链接保留静态地址；超过 9 层的列表标记为静态编号；字体回退固定提示。
- 路径校验复用 HTML 导出的规则，编码路径去重；仅本地相对 PNG/JPEG 可交给授权资源加载器。缺失、受限、无效图片默认阻止生成，显式允许占位才可继续；配额错误和取消不能转换为占位。
- 资源预检克隆模型，串行加载图片并返回独立字节集合。检查单图/总量、图片头与尺寸，取消后停止后续读取；已完成的预检不能直接再预检，重试须从当前正文重建。
- 文本限 10 MiB、100,000 节点、500 张去重图片、总 AST 深度 128、图片总量 128 MiB。增加深度限制是为了保护递归映射，不改变正文保存或源格式。

## 依赖与 Worker 验证

锁定 `docx@9.10.0`（MIT）。JSZip 选择 MIT，pako 保留 MIT 与 Zlib，sax 保留 Blue Oak 1.0.0。完整文本、来源和 SBOM 已同步；hash.js/isarray 的许可来自锁定上游提交的 README，pako 的 Zlib 文本来自嵌套 README，已与安装源码核对。

Windows 清单包含 429 个依赖版本；233 个内容寻址许可文件散列全部通过，缺失许可文本为 0。文件数包括原有已保留文本，不等于新增依赖数。macOS 原有许可复核与各平台 Cargo 清单仍按原计划验收。

`pnpm.cmd verify:docx-library` 使用应用 Vite 配置和 CSP 构建独立验证 Worker。默认浏览器解析条件会选择需要 `document` 的实体解码器；复用现有 `worker` 条件后，原始 AST/办公样例模型/资源预检和库生成均可在没有 DOM 的真实 Chromium Worker 中运行。验证入口已纳入统一回归与 CI 结果上传。

候选库探针生成的是专用 API 样例：中文/emoji、标题、粗斜体/删除线、安全链接、起始值 3 的编号、两列表格与重复表头、原字节 PNG。解压检查 ZIP CRC32、必要 OOXML 项、合法 XML、媒体字节、无宏/OLE/远程图片关系；期间没有外部网络请求。

本机 Chromium 156.0.8078.4、Node 24.19.0，探针构建 570,295 字节，统一回归中样例输出 13,644 字节，一次 Worker 任务 309 ms。此时间包含样例模型预检与库生成，不代表完整文档性能、峰值内存或真实办公软件排版。nanoid 6.0.2 的 Node 条件为 `^22 || ^24 || >=26`；CI Node 22 满足条件，不能仅依据 docx 的 Node >=10 声明设置环境。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm.cmd typecheck` | 通过 |
| `pnpm.cmd test`（Vitest JSON reporter） | 23 个测试文件、136 项单测全部通过，其中模型 11 项 |
| `pnpm.cmd build` | 通过，仍有原有大 chunk 提示 |
| `pnpm.cmd verify:workers` | 生产 Markdown/图片/搜索 Worker 初始化与既有断言通过 |
| `pnpm.cmd verify:docx-library` | 真实 Worker、共享模型与库 API/ZIP/XML 检查通过 |
| `pnpm.cmd verify:browser`、`verify:writing` | 图片/草稿流程、选区/格式、滚动与主题回归通过 |
| `pnpm.cmd verify:live`、`verify:export` | 即时渲染和安全 HTML/打印回归通过；浏览器 PDF 12 页 |
| `pnpm.cmd verify:regression` | 完整统一入口的 10 项检查全部通过，包含新增 DOCX 探针 |
| 严格 `generate-notices.mjs` / `verify-notices.mjs` | Windows 清单/文本/来源散列通过 |
| `git diff --check` | 通过 |

单测仍输出现有 React act 提示。此次没有修改 Rust/原生文件层，也未把旧桌面包当作本步源码验证结果。可审查数据见 [3A 验证记录](verification/v0.3-step3a-verification.json)，临时产物在忽略目录 `test-results/`。

## 下一步：3B

1. 实现模型到完整 OOXML 的生成器：全部受支持块、页型/边距、列表嵌套、表格、代码和图片布局，并验证冻结样例内容不丢失。
2. 接入按需 Worker、解析/生成各 60 秒超时、取消、完整图片解码、授权读取与 192 MiB 输出限制。
3. 新增 Rust 独立二进制保存命令：`.docx`/OOXML 校验、原生另存授权、打开文件保护、原子替换与竞态/失败恢复。

3C 再接入菜单/预检/占位确认/进度与焦点，验收正文、dirty、草稿和撤销保持，以及 Word/LibreOffice/WPS 可编辑性和排版。当前探针没有将办公样例的全部模型转换为 DOCX，不能代替这项验收。
