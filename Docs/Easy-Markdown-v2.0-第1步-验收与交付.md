# EasyM v2.0 第 1 步：验收与交付

日期：2026-10-20。结论：验证工具与核心逻辑完成；真实服务未满足条件更新契约，第 1 步退出条件未达成，Provider 选择待维护者决定。详见[能力报告](Easy-Markdown-v2.0-第1步-WebDAV能力报告.md)。

## 1. 交付内容

- [提交清单](../src/core/sync-commit.ts)：schemaVersion 1 清单、不可信字节解析（未知字段、跨平台非法路径、大小写冲突、重复身份、1.0 图片限额）、确定性编码、按内容地址校验读取；先对象、再清单、最后条件推进头的发布流程；unknown 结果按祖先链判定 committed/superseded/absent/undetermined。
- [内存 Provider](../src/core/sync-memory-provider.ts) 用于确定性故障注入；[新增 15 项单测](../src/core/sync-commit.test.ts)。
- `scripts/webdav/`：按 digest 固定的 compose 环境、Apache DAV 配置、仅限验证的 WebDAV 适配器（不跟随重定向、拒绝跨源、限制响应大小）及原语探针；`pnpm verify:webdav` 对真实服务运行契约检查。
- 脱敏证据：[webdav-report.json](verification/v2.0/step-1/webdav-report.json)（SHA256 `c17d720d…a28c`）、[primitive-probes.txt](verification/v2.0/step-1/primitive-probes.txt)。证据不含凭据、端点主机名或用户路径。

未接入编辑器、原生层或设置界面；未改应用版本、依赖或锁文件。适配器为 Node 验证脚本，不是发布用 Provider。

## 2. 实际验证

| 检查 | 结果 |
| --- | --- |
| `corepack.cmd pnpm typecheck` | 通过 |
| `corepack.cmd pnpm test --maxWorkers=2` | 57 个文件、339 项全部通过（含新增 15 项） |
| `corepack.cmd pnpm build` | 通过（含 tsc -b；Vite 32 秒，保留既有 >500 kB chunk 提示） |
| `pnpm verify:webdav`（Apache 2.4.69、Nextcloud 31.0.14） | 两者均未通过：Apache 创建与 If-Match 竞争多重成功；Nextcloud 创建竞争多重成功、423 导致无进展轮次。每个服务 19 项检查通过 17 项 |

运行 compose 环境需维护者本机启动容器（本会话权限限制）。Windows 凭据助手在会话中不可用，镜像经 WSL 匿名拉取；容器与 `test-results/v2.0/step-1/` 的凭据可随时删除。

## 3. 构建

构建产物未发布；`git diff --check` 通过。验证脚本将核心模块打包到被忽略的 `test-results/v2.0/step-1/core/`，避免进程内 Vite 开发服务器在 Windows 上阻塞 HTTP 套接字。

## 4. 下一步

需维护者在能力报告第 4 节的三个方向中选择：MKCOL 提交日志、仅支持 Nextcloud、或转向 Git。选定后在本分支或新的独立变更中修订 RFC 第 4 节、实现并重复同等规模的竞争验证，再冻结支持清单。第 2 步身份迁移不依赖该决定，但按计划须待第 1 步合并后开始。
