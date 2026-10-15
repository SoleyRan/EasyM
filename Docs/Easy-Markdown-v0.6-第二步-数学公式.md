# EasyM v0.6 第二步：数学公式

冻结日期：2026-10-15。第一步提交 `afaaac9`，当前分支 `feature/v0.6`，产品版本保持 0.5.0。

## 实现契约

- 使用固定版本 `remark-math@6.0.0` 解析公式、`katex@0.19.0` 生成 MathML，`hast-util-from-html@2.0.3` 解析生成树。独立实现，不引入 MarkText 代码或资源。新依赖的实际许可证与清单随本步记录。
- 行内公式为 `$…$`；公式内容首尾不能有空白，单美元围栏不能跨行，结束美元后不能紧接数字，避免常见 `$5 and $10` 货币文本。转义 `\$`、行内代码、代码块和 Front Matter 不渲染。歧义美元可转义；不宣称自动理解所有货币文本。块公式使用独占行的 `$$` 围栏；不保证同一行 `$$…$$` 的显示模式。
- 预览/阅读使用原生 MathML，无远程字体、脚本、图片或网络请求。允许的 MathML 元素/属性单独白名单清理；Markdown 本身仍经过原有 HTML 清理。KaTeX `trust:false`、`strict:'error'`、宏展开最多 1000、最大尺寸 20em；不共享文档宏，不允许 URL、HTML、图片或定义宏等命令。
- 单公式最多 16 KiB 字符、每份文档最多渲染 200 个公式、公式输入合计最多 128 KiB、单个生成输出最多 256 KiB。解析在既有 Worker 内进行；预览任务超过 5 秒终止 Worker，保留源码并提示，后续编辑可重试。结果校验正文/渲染选项修订，取消或失效结果不得进入其他标签。公式错误/超限显示完整源码及简短说明，其他段落可继续预览。
- EM → 设置新增独立“数学公式渲染”开关，默认启用、本机持久化；不随恢复默认外观重置。关闭后公式展示完整围栏源码，HTML/PDF 同步使用此选择，DOCX 始终保留公式源码。
- 即时渲染：块公式在非活动块显示结果，点击或“源码”按钮返回原始可编辑块，活动/拖选/输入法期间保留源码。行内公式本步保持源码编辑，不增加行内公式浮层。任何显示/导出都不改写源文或影响撤销与自动保存。
- HTML 为离线静态 MathML（保留 TeX annotation），打印/PDF沿用 MathML；错误/关闭/超限则打印完整源码及提示。需要现代支持 MathML 的浏览器/WebView；本步验收 Chromium，其他平台真实 GUI 最后阶段验收。DOCX 以完整带围栏 LaTeX 静态可编辑原文导出，预检明确说明不生成 Word 原生公式；不静默生成错误公式或联网转换。

## 验收

覆盖行内/块公式、分数/根号/求和/矩阵、中文邻接、货币/转义/代码、脚注/表格嵌套、危险命令、宏展开、尺寸与总量限额、错误后继续渲染、设置开关及持久化、多标签/过期任务、即时渲染回源码和撤销、四主题/紧凑窗口、独立离线 HTML、打印 PDF 与 DOCX 降级。类型检查、前端测试、生产构建及全量生产回归完成后归档到 `Docs/verification/v0.6/step-2/`。

当前状态：实现及本机验收已完成；第二步尚未提交。

类型检查、生产构建、48 个文件的 271 项单测与全部 25 组生产回归通过。归档见 [验收摘要](verification/v0.6/step-2/acceptance-summary.json)、[数学专项报告](verification/v0.6/step-2/math-verification.json)、[全量回归报告](verification/v0.6/step-2/regression-verification.json)、[单测日志](verification/v0.6/step-2/unit-output.txt)、[回归日志](verification/v0.6/step-2/regression-output.txt) 和 [深色主题截图](verification/v0.6/step-2/screenshots/dark.png)。生成的 HTML/PDF/DOCX 在本机 `test-results/math/`，字节数与哈希见 [导出产物记录](verification/v0.6/step-2/export-artifacts.json)。

完整回归发现并修复“撤销恢复源码后，预览语言按钮暂时无响应”的状态判断；只在公式选项改变时作废相同源码的预览，仍拒绝过期 Worker 结果。一次并发执行单测/浏览器回归导致自动保存测试超时，最终单测独立运行全部通过。测试日志中的 happy-dom KaTeX quirks 提示与既有 React act 提示不代表生产浏览器失败；生产专项无页面错误和外部请求。

构建体积对比第1步：主 JS 从 2,041,523 增至 2,951,871 字节（gzip 从 666,939 至 937,608）；全部 dist assets 从 3,701,885 至 4,619,193 字节。内联 Worker 与主入口包含数学解析/渲染依赖，未增加字体资源，Vite 的大 chunk 提示仍存在；详细清单见 [构建对比](verification/v0.6/step-2/build-comparison.json)。本步记录功能成本，第4步再统一性能与交付验收。

## 使用方法与限制

行内输入 `$E=mc^2$` 或 `$1+2=3$`；块公式将起止 `$$` 分别放在单独一行，中间输入 `\frac{1}{2}+\sqrt{x}`。样例见 [数学公式](samples/v0.6/数学公式.md)。分屏或阅读模式查看行内/块公式；即时渲染点击块公式或“源码”按钮可继续编辑。设置路径为 EM → 设置 → Markdown 扩展 → 数学公式渲染。

即时渲染暂保留行内 LaTeX 原文；表格编辑弹窗的单元格小预览也保留公式原文，完整文档预览/阅读中的表格公式正常渲染。公式编辑器、自动补全和 Word 原生公式不在本步范围。

依赖清单包含实际使用的 KaTeX、remark-math 等开源库的许可，与是否借鉴 MarkText 设计无关。固定的 3 个直接依赖共新增 17 个生产依赖版本，Windows 依赖清单共 447 项，许可全文缺项为 0。remark-math npm 发布包缺少许可文件，已从 npm gitHead `d5d0660b150810a535bbb07eac6cc96a4510aa24` 补齐并记录来源/哈希。

## 可复现验收

在本机终端运行，浏览器脚本启动独立 Chromium profile 和 dist 静态服务；没有后台云端验收。当前日志为 `test-results/v06-step2-unit.log`、`test-results/v06-step2-build.log`、`test-results/v06-step2-regression.log`。CI 使用相同回归入口并上传数学公式报告及图片/导出产物。

```powershell
pnpm.cmd typecheck
pnpm.cmd exec vitest run --maxWorkers=2
pnpm.cmd build
pnpm.cmd verify:math
pnpm.cmd verify:regression
node scripts/verify-notices.mjs
```

本步不改 Rust 层，不重新生成安装包；远端 CI、真实 IME、系统打印分页、Word 和 macOS/Linux GUI 留到统一交付验收。下一步为第3步 Mermaid，按后续指令开始。
