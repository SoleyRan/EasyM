# EasyM v2.0 第 1 步：验收与交付

日期：2026-10-21。结论：第 1 步本地验收通过。全局头指针条件更新被实测否定，改为每设备单写者日志后，两个固定版本服务全部检查通过；支持清单与远端协议已冻结。详见[能力报告](Easy-Markdown-v2.0-第1步-WebDAV能力报告.md)。

## 1. 交付内容

- [同步契约](../src/core/sync-contract.ts)：设备头 `devices/<deviceId>.json`（schemaVersion、workspaceId、deviceId、sequence、commitHash）及不可信字节解析；Provider 接口改为列出/读取/写入设备头和不可变对象；保留合并作者 ID。
- [提交清单](../src/core/sync-commit.ts)：schema 1，不可信字节解析（未知字段、跨平台非法路径、大小写冲突、重复身份、1.0 图片限额、父提交规则）、确定性编码、按摘要校验读取；先对象后清单的上传。
- [每设备日志](../src/core/sync-log.ts)：一轮同步（确认未决写入、读取全部设备头、上传、确定性合并、只推进本设备头）；按 documentId 的三方合并，路径与内容分别合并，冲突副本、编辑优先于删除、同路径改名；双安装、回滚、删除头、未决写入的检测与恢复。
- [内存 Provider](../src/core/sync-memory-provider.ts) 可模拟非原子条件写和响应丢失；单测：契约 9 项、清单 10 项、日志 15 项。
- `scripts/webdav/`：按 digest 固定的 compose 环境、Apache DAV 配置、仅限验证的 WebDAV 适配器（不跟随重定向、拒绝跨源、限制响应大小、列表不完整即报错）、原语探针；`pnpm verify:webdav` 用 4 台独立模拟设备对真实服务运行检查。
- RFC 第 4、5、6 节按实测修订；实施计划与 README 更新状态。
- 脱敏证据（不含凭据、端点主机名或用户路径）：
  - [webdav-report.json](verification/v2.0/step-1/webdav-report.json)：每设备日志，SHA256 `d13532e2…ccd2`
  - [head-cas-report.json](verification/v2.0/step-1/head-cas-report.json)：第一轮头指针 CAS，SHA256 `c17d720d…a28c`
  - [primitive-probes.txt](verification/v2.0/step-1/primitive-probes.txt)：原语测量，SHA256 `d5f4b0b4…7a82`

未接入编辑器、原生层或设置界面；未改应用版本、依赖或锁文件。适配器为 Node 验证脚本，不是发布用 Provider。

## 2. 实际验证

环境：Windows NT 10.0.26200.0，Node.js v24.20.0，Corepack 调用 pnpm 11.25.0，Docker Engine 29.6.2。

| 检查 | 结果 |
| --- | --- |
| `corepack.cmd pnpm typecheck` | 通过 |
| `corepack.cmd pnpm test --maxWorkers=2` | 58 个文件、350 项全部通过；耗时 115 秒 |
| `corepack.cmd pnpm build` | 通过（含 tsc -b；Vite 46 秒，保留既有 >500 kB chunk 提示） |
| `pnpm verify:webdav apache`（2.4.69） | 16/16 通过 |
| `pnpm verify:webdav nextcloud`（31.0.14） | 16/16 通过 |
| `git diff --check`、文档相对链接、证据脱敏检查 | 通过 |

compose 环境由维护者在本机启动（本会话权限限制）。Windows 凭据助手在会话中不可用，镜像经 WSL 匿名拉取。验证脚本把核心模块打包到被忽略的 `test-results/v2.0/step-1/core/`，避免进程内 Vite 开发服务器在 Windows 上阻塞 HTTP 套接字。容器与 `test-results/v2.0/step-1/` 中的凭据可随时删除。

未运行：TLS、外部网络、原生凭据存储、原生 GUI、Rust 测试和跨平台包构建；字节保真、图片落地和本地外部修改属于第 2/3 步。

## 3. 已知限制

- Nextcloud 回环环境下 4 设备单轮同步 p50 约 26 秒，原因是测试设备每轮全量读取提交和对象；第 3 步须加入本地已校验对象缓存和差异下载。
- 同一文档双方并发编辑目前保存为冲突副本，不做行级合并；第 4 步接入现有三方合并与冲突界面。
- 远端历史只增不减，首发不做检查点和回收；单轮历史读取上限 10000 个提交，超限暂停。

## 4. 下一阶段交接

第 1 步合并 main 后，从 main 创建 `feature/v2.0-step-2-identity`：持久 documentId/workspaceId、`.easym/sync/workspace.json`、迁移与快照、受控重命名/移动/删除及链接处理。本阶段不创建后续分支，不推送、合并或发布。
