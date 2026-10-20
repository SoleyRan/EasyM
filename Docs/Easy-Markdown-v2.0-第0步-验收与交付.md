# EasyM v2.0 第 0 步：验收与交付

日期：2026-10-20。结论：第 0 步本地验收通过，可独立评审；后续阶段尚未实施。

## 1. 分支与范围

- 分支：`feature/v2.0-step-0-contracts`，从本地 main `39fc43cadc08be6f1e564499b360137e58d4a23e` 创建。
- [实施计划](Easy-Markdown-v2.0-设计与实施计划.md)拆分第 0–6 步及独立分支，记录当前决策与各阶段退出条件。
- [RFC](Easy-Markdown-v2.0-第0步-RFC.md)记录 1.0 发布/CI 基线、桌面首发范围、WebDAV 验证目标、历史身份兼容规则、远端布局、并发提交和恢复边界。
- [同步契约](../src/core/sync-contract.ts)定义带取消信号的 Provider、显式条件创建/更新、committed/conflict/unknown 结果及不可信远端头解析器。
- [新增测试](../src/core/sync-contract.test.ts)覆盖合法指针、跨工作区、未知 schema、缺失/额外字段、非法摘要/身份、UTF-8/JSON 损坏及 4096 字节边界；包括尾随换行的标识符和摘要。
- README 反映 1.0 已发布与当前阶段；按维护者要求忽略根目录 `.vscode/` 与 `codex-install.ps1`。

当前代码未接入编辑器或网络，不写入用户工作区同步元数据。应用版本、依赖清单/锁文件与 Rust 实现保持原状；本阶段不构成可用同步功能或真实服务兼容声明。

## 2. 实际验证

环境：Windows NT 10.0.26200.0，Windows PowerShell 5.1.26100.9711，Node.js v24.20.0，Corepack 调用 pnpm 11.25.0。

| 检查 | 结果 |
| --- | --- |
| `corepack.cmd pnpm install --frozen-lockfile` | 通过，未修改锁文件 |
| `corepack.cmd pnpm typecheck` | 通过，退出码 0 |
| `corepack.cmd pnpm test --maxWorkers=2` | 56 个文件、324 项全部通过，含新增 8 项；耗时 100.05 秒 |
| `corepack.cmd pnpm build` | 通过，含最终代码的 TypeScript 检查；Vite 构建 42.86 秒 |
| `git diff --check` 及文档相对链接检查 | 通过 |
| 忽略规则、main 基线与版本/锁文件差异检查 | 通过 |

单测输出含 KaTeX quirks mode 与 React act 提示，构建含大于 500 kB 的 chunk 提示；本轮命令均成功，未在本阶段扩展为编辑器或打包优化。类型检查、测试和构建原始日志保存在本机 `test-results/v2.0/step-0/`，不纳入 Git。

安装前发现旧 node_modules 的 Windows 链接不可用，已将原目录移至被忽略的 `test-results/v2.0/step-0/node_modules-backup`，再按冻结锁文件重装并完成上述检查。

本轮未运行原生 GUI、Rust 测试、跨平台包构建或真实 WebDAV 故障验证；新增模块尚未接入运行路径，相关验证在对应后续阶段执行。RFC 中的场景矩阵和规模预算为待验证目标。

## 3. 下一阶段交接

第 0 步评审合并 main 后，从 main 创建 `feature/v2.0-step-1-webdav`。该阶段验证固定版本 Nextcloud WebDAV 与 Apache httpd mod_dav：条件创建、强 ETag/If-Match、双客户端竞争、响应丢失、取消及读后可见性，产出可复现脚本、隔离样例、脱敏证据和明确支持清单，同时冻结完整提交清单 schema。

若真实服务不满足条件更新契约，先调整 Provider 方案；不得退化为无条件覆盖。第 1 步通过后，身份迁移仍在第 2 步的独立分支实施。本阶段不创建后续分支，不推送、合并或发布。
