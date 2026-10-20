# EasyM v2.0 第 1 步：WebDAV 能力报告

日期：2026-10-20。分支：`feature/v2.0-step-1-webdav`，从 main `058a994` 创建。结论：两个目标服务均未满足 RFC 第 4 节的条件更新契约，第 1 步退出条件（支持清单与 Provider 冻结）未达成，需维护者决定后续方向。

## 1. 环境与范围

| 项 | 版本 / 设置 |
| --- | --- |
| Apache httpd mod_dav_fs | 2.4.69，`httpd@sha256:c842ac79…6785a`，FileETag MTime Size |
| Nextcloud | 31.0.14（apache 镜像 `sha256:07ec73cc…3767`），MariaDB 11.4.13，Redis 7.4.11（事务文件锁） |
| 宿主 | Windows 11 26200，Docker Engine 29.6.2 / Compose v5.3.1（WSL2），Node.js v24.20.0 |

容器仅绑定 127.0.0.1，HTTP 明文、Basic 认证、随机凭据保存在被忽略的 `test-results/v2.0/step-1/`。每次运行使用新 workspaceId 命名空间。结果只代表上述固定版本的回环环境，不代表 TLS、反向代理、外部网络、其他存储后端或其他版本。

## 2. 契约检查结果

入口 `pnpm verify:webdav`（`scripts/verify-webdav.mjs`），复用 `src/core` 的发布/解析逻辑。证据：[webdav-report.json](verification/v2.0/step-1/webdav-report.json)。

| 检查 | Apache | Nextcloud |
| --- | --- | --- |
| 错误凭据报错而非“不存在”、拒绝跨源请求、缺失头为 absent | 通过 | 通过 |
| 不可变对象 If-None-Match:* 防覆盖、哈希不符拒绝 | 通过 | 通过 |
| 头指针 GET 强 ETag；弱 If-Match 不写入 | 通过（修改后 1 秒内为弱 ETag，需等待） | 通过 |
| PUT 响应携带 ETag | 否，所有发布需按祖先链判定 | 是 |
| **首次创建竞争（10 轮 × 8 客户端）仅一个 2xx** | **失败：8/10 轮多个 201** | **失败：1/10 轮 201+204** |
| **If-Match 竞争（20 轮 × 8 客户端）仅一个 2xx** | **失败：13/20 轮多个 204** | 通过（0 次） |
| If-Match 竞争每轮有进展 | 通过 | 失败：3/20 轮全部 423 Locked |
| 同尺寸重写 ETag 变化、旧 ETag 冲突 | 通过 | 通过 |
| 响应丢失（服务应答后断开 / 发送后断开）判定一致且重试不重复 | 通过 | 通过 |
| 被其他设备覆盖后判定 superseded；上传中取消不推进头；写后读可见 | 通过 | 通过 |

“多个 2xx”表示服务对同一基线的多个条件写都回复成功，最终只保留最后一个。被覆盖的写入方若已接受“已提交”，其提交会从头链中消失，即 RFC 禁止的静默丢失。祖先链判定只能在覆盖发生后才能发现，不能替代原子 CAS。

## 3. 原语补充测量

脚本位于 `scripts/webdav/probes/`，原始输出见 [primitive-probes.txt](verification/v2.0/step-1/primitive-probes.txt)。

| 原语 | Apache | Nextcloud |
| --- | --- | --- |
| 同基线 If-Match，2 客户端 × 50 轮 | 50/50 轮双方均 204 | 无多重成功；23–33/50 轮双方 423 |
| If-None-Match:* 创建，50 轮 | 2 客户端：50/50 轮双方均 201 | 2 客户端 1/50、8 客户端 9/50 轮多个 2xx |
| MKCOL 同名集合，16 客户端 × 100 轮 | 每轮恰一个 201 | 每轮至多一个 201；6 轮全部 423 |
| MOVE Overwrite:F 到同一目标，8 客户端 × 30 轮 | 27/30 轮多个 201 | 无多重成功；124 次 500，2 轮目标内容来自返回 500 的请求 |
| 排他 LOCK | 13/30 轮多个持锁者 | 不支持（501） |
| 唯一名称追加 PUT + PROPFIND 列表（240 项） | 全部可见 | 全部可见（重试 423 后） |

MKCOL 同名创建是两个服务中唯一观察到满足互斥的原语；追加唯一名称对象在两者上均可见。Apache 的 mod_dav_fs 条件检查与写入之间无原子保护，LOCK 在并发下亦非排他。Nextcloud If-Match 更新未观察到多重成功，但文件锁冲突会使全部竞争者失败，需要退避重试。

性能（回环，单次测量）：Apache 1 MiB 上传 62 ms、下载 5 ms、读头 3 ms；Nextcloud 分别为 241、211、212 ms，8 客户端竞争轮次 p50 1.1 s。不能作为外部网络承诺。

## 4. 对 RFC 的影响与可选方向

RFC 规定：不能满足条件更新契约时暂停可写接入，不退化为无条件覆盖，不同时开发两个 Provider。可选方向：

1. **基于 MKCOL 的提交日志**：以 `log/<序号>/` 同名 MKCOL 竞争下一序号，替代头指针 CAS；需另行设计“已占位未写入”恢复规则，并在两个服务重复验证。
2. **仅支持 Nextcloud**：可写同步只开放给 If-Match 原子的服务，首次创建改用 MKCOL 初始化，Apache 类服务降级为导入/导出；单一实现，覆盖面窄。
3. **按 RFC 转向 Git**：独立变更评估 Git Provider（服务端原子更新 ref），WebDAV 暂停。

本阶段未冻结支持清单和最终 wire schema；`src/core/sync-commit.ts` 的提交清单 schema 与上传/判定逻辑不依赖头指针机制，可在任一方向复用。
