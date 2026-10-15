# EasyM v0.6 第一步：脚注与 Front Matter

日期：2026-10-14。基于已合并 v0.5 的 main `90c4ce7`，开发分支 `feature/v0.6`。本步沿用现有依赖，不改原生文件协议；产品版本暂保留 0.5.0，最终交付步骤统一升到 0.6.0。

## 已实现

- GFM 脚注按首次引用编号，重复引用共享说明且各自有返回入口；大小写归一化、首次定义生效。缺失定义保持原文；未引用和重复定义以静态原文显示，不再静默消失。
- 分屏和阅读模式支持点击上标/返回箭头、键盘聚焦后 Enter 导航。分屏定位目标源码，阅读模式只定位预览。DOM 查找限制在当前标签，检查活动状态、编辑锁、输入法和 Worker 正文版本；脚注不会误打开普通链接编辑器。
- 保持默认 HTML 清理与 DOM clobbering 前缀，清理后仅修复目标仍存在的脚注锚点。脚注里的标题不加入主文档大纲；文末定义不进入按源码顺序的滚动插值，大纲在阅读模式优先按精确源码位置定位。
- Front Matter 文件头 YAML/TOML 展示完整静态原文及类型标签，包含围栏。元数据不执行、不应用到设置；未知或未闭合围栏继续普通 Markdown。即时渲染保留元数据及脚注标记供编辑。
- HTML 导出保留有效的内部锚点；打印/PDF 显示文末脚注区。DOCX 生成可编辑上标与文末“脚注”，预检明确提示不是 Word 原生逐页脚注；脚注内格式、列表、链接和图片沿用既有映射及权限/限额。
- 共享脚注索引处理正文引用后继续遍历已使用定义，每个定义一次；循环/自引用不递归展开。DOCX 只登记实际映射的图片，远程/缺失资源沿用阻止或明确占位导出。
- 四主题显示、静态元数据与脚注区样式、键盘焦点提示；生产脚注验收接入统一回归及 CI 证据上传。

## 使用

```markdown
正文[^说明]，再次引用[^说明]。

[^说明]: 支持 **加粗**、链接等。

    缩进四空格可继续第二段。
```

```markdown
---
title: 文档标题
tags: [Markdown, 办公]
---
```

TOML 使用 `+++` 围栏。完整样例见 [脚注与元数据](samples/v0.6/脚注与元数据.md)。源码是唯一正文，显示/导航/导出不会改写原文；手工编辑仍沿用自动保存与撤销。

## 验证与证据

验证结果和构建摘要见 [验收摘要](verification/v0.6/step-1/acceptance-summary.json)。本机生产回归由 `pnpm verify:regression` 启动独立 Chromium profile 和生产 dist 静态服务，没有后台云端回归。

本轮类型检查、生产构建、46 个文件中的 261 项前端测试及全部 24 组生产回归通过。可直接查看已归档的 [完整回归报告](verification/v0.6/step-1/regression-verification.json)、[脚注专项报告](verification/v0.6/step-1/extensions-verification.json)、[回归日志](verification/v0.6/step-1/regression-output.txt) 和 [紧凑窗口截图](verification/v0.6/step-1/screenshots/compact.png)。原有 DOCX 交互验收曾暴露撤销/重做后 DOM 选区滞后的测试输入竞争；测试辅助函数改用编辑器快捷键全选后输入，完整回归已重新通过。

实时日志：`test-results/v06-step1-unit.log`、`test-results/v06-step1-build.log`、`test-results/v06-step1-regression.log`；这些运行产物不提交 Git。可重复执行：

```powershell
pnpm.cmd typecheck
pnpm.cmd test --maxWorkers=2
pnpm.cmd build
pnpm.cmd verify:extensions
pnpm.cmd verify:regression
```

针对性验证覆盖编号/大小写/重复与未引用定义、缺失与中文/特殊标识、循环、静态 YAML/TOML、安全转义、源码范围、图片预检、可编辑 DOCX 上标；生产交互覆盖脚注往返、第二标签同 ID 隔离、阅读及退出、四主题/紧凑布局、独立 HTML 内部链接、打印/PDF、DOCX 下载、即时渲染标记、普通撤销和前置定义/阅读大纲。

本步不生成安装包、不声称 Word 实机或系统打印分页/读屏验收。未改 Rust 层，因此本轮不重复运行原生测试；远端 CI 在提交推送后另行验收。现有真实 IME、原生对话框、macOS/Linux GUI 和签名/发行待办保留。

## 下一步

第2步先冻结公式语法、受限渲染依赖和各导出渠道的降级契约，再实现数学公式；Mermaid 是第3步。本轮停在第1步可审查结果，提交/推送按用户指令执行。
