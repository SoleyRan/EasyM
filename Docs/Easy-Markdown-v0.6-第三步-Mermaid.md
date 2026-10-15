# v0.6 第三步：Mermaid

冻结日期：2026-10-15；本步保持产品版本 0.5.0。第二步已提交 `ff81da3`。

## 功能与输出契约

使用固定版本 `mermaid@12.2.0`，离线打包官方浏览器引擎，仅遇到启用的 Mermaid 围栏才创建渲染沙箱和加载引擎。保证 `flowchart`/`graph` 流程图与 `sequenceDiagram` 时序图；其他图类型显示完整围栏源码及说明。设置独立保存 Mermaid 开关，不影响数学公式。

分屏、阅读和即时渲染共用静态图；即时渲染的活动块继续显示可编辑源码。显示结果绑定源文、设置、主题及组件生命周期，取消后忽略结果并移除沙箱。四个主题映射独立配色，导出固定浅色保证纸上对比度。

HTML/系统打印 PDF 内嵌清理后的 SVG data 图片，无脚本、网络或运行时依赖，并附完整源码折叠区；错误、禁用、超限时展示源码及原因。DOCX 始终保留完整、可编辑的 Mermaid 围栏，并在预检提示此降级，不冒充可编辑图形。浏览器 PDF 验证不等于系统打印或原生 WebView 验收。

## 安全与限制

渲染在独立本地 HTML iframe（sandbox 仅 allow-scripts，无同源权限、导航、表单、弹窗权限）中进行，运行页 CSP 禁止网络、图片和外部样式。父窗口校验消息来源窗口与随机请求标识，不接收文档提供的 SVG。引擎 strict、禁用 HTML 标签与交互，不运行 bindFunctions。拒绝配置指令、Front Matter、click/link、HTML、URL、图像、样式/classDef/style 等扩展输入；正文不获得修改配置或资源读取权限。普通代码块不执行。

每图最多 8,000 UTF-16 字符、120 行、120 条语句；每文档最多 12 图、32,000 图源码字符。每图加载加渲染最多 5 秒、全任务最多 20 秒，超时移除 iframe。SVG 最多 1 MiB、10,000 元素、视口边长 8,192；拒绝 DOCTYPE，按 SVG 元素/属性白名单重建，丢弃事件、foreignObject、脚本、链接、外部引用与危险 CSS，仅允许内部片段引用。图片经过清理后作为不可交互 image 呈现。输入有界和计时移除不等于独立进程 CPU 硬中断：各平台 iframe 布局调度仍需交付阶段验证。

## 验证与交付

单测覆盖输入策略、SVG 清理、源码保留、DOCX 降级及设置；生产浏览器覆盖两种图、延迟加载、无外部网络、主题、源码编辑、切换、禁用、错误、静态导出和 PDF。本步更新许可/SBOM、构建体积和证据；统一导引、版本、原生三平台和 Windows 安装包留第四步。

## 本机验收结果

当前状态：第三步实现及本机验收完成，尚未提交。类型检查、生产构建、49 个文件的 279 项单元测试和全部 26 组生产回归通过。完整回归在本机终端串行运行，使用 dist 静态服务与独立 Chromium profile（156.0.8078.4），最终运行时间为北京时间 2026-10-15 11:07:34 至 11:13:25。没有后台云端验收。

证据见 [验收摘要](verification/v0.6/step-3/acceptance-summary.json)、[Mermaid 专项报告](verification/v0.6/step-3/mermaid-verification.json)、[完整回归报告](verification/v0.6/step-3/regression-verification.json)、[单测日志](verification/v0.6/step-3/unit-output.txt)、[回归日志](verification/v0.6/step-3/regression-output.txt)、[深色主题截图](verification/v0.6/step-3/screenshots/dark.png) 和 [独立 HTML 截图](verification/v0.6/step-3/screenshots/standalone.png)。本机原始日志为 `test-results/v06-step3-unit.log`、`test-results/v06-step3-build.log` 和 `test-results/v06-step3-regression.log`。

专项六组覆盖按需加载、中文流程图/时序图、四主题、紧凑窗口、阅读/即时渲染回源码、设置持久化与公式开关独立、多标签隔离、完整围栏保留、静态离线 HTML、浏览器打印 PDF、DOCX 降级提示与真实下载、危险输入及文档限额、引擎加载失败/超时移除、编辑取消与过期结果拒绝。最终专项没有外部网络请求或页面异常。生成的 HTML/PDF/DOCX 在 `test-results/mermaid/`，归档其 [大小及 SHA-256](verification/v0.6/step-3/export-artifacts.json)，不把浏览器打印 PDF 当作系统打印机或原生 WebView 验收。

接入多页构建后，首次完整回归发现 DOCX 库探针继承多入口，与 IIFE 格式不兼容；为探针显式指定自己的单入口，最终完整回归通过。测试导引初始化也限定在顶层页面，避免在无同源权限的图表沙箱访问 localStorage。SVG 清理保留安全配色规则、移除默认动画；已人工查看浅色、深色、时序图和离线导出截图。日志中的既有大 chunk、happy-dom quirks 和 React act 提示保留记录。

## 构建与依赖

固定使用官方完整浏览器包，不从 CDN 下载引擎。流程图与时序图以外的引擎虽包含在官方包中，产品仍按本步契约回退源码。相比 `ff81da3`，主 JS 从 2,951,871 增至 2,959,875 字节（gzip 从 937,608 至 940,758）；延迟加载引擎单独为 5,494,801 字节（gzip 1,584,297），普通 Markdown 不请求/执行。全部 dist assets 从 4,619,193 增至 10,122,636 字节；这是离线打包完整引擎的成本。详细对比及新增依赖见 [构建对比](verification/v0.6/step-3/build-comparison.json)。

Windows 依赖清单从 447 增至 563 个版本，296 份许可文件全部通过哈希核对，许可全文缺项为 0。新增库保留其实际许可，Windows 清单不代替 macOS/Linux 清单验收。本步不改 Rust 层，不重打安装包，产品版本保持 0.5.0；统一版本、导引、性能、真实 WebView/系统打印/Word 与三平台交付留第四步。

## 使用与复现

使用语言为 `mermaid` 的代码围栏，在其中写 `flowchart TD`、`graph LR` 或 `sequenceDiagram`。完整样例见 [Mermaid.md](samples/v0.6/Mermaid.md)。分屏和阅读模式显示图表；展开“图表源码”可查看完整输入，即时渲染点击“源码”返回编辑。设置路径为 EM → 设置 → Markdown 扩展 → Mermaid 图表渲染。自定义样式、配置、链接点击、外部资源及其他图类型当前保留源码并提示。

```powershell
pnpm.cmd build
pnpm.cmd exec vitest run --maxWorkers=2
pnpm.cmd verify:mermaid
pnpm.cmd verify:regression
node scripts/verify-notices.mjs
pnpm.cmd verify:release
```

浏览器回归串行运行；单元测试和完整浏览器套件分开执行，以减少计时干扰。CI 使用相同完整回归入口，上传 Mermaid 报告、截图和导出样本。本步已提交 `744d9f7`；后续统一交付见第四步记录，本页保留第三步历史验收。
