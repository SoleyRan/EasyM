# EasyM v2.0 第 2 步：验收与交付

分支：`feature/v2.0-step-2-identity`，从 main `10e42f0`（第 1 步合并）创建。按维护者决定分三次提交：2A 身份与协调、2B 受控重命名/删除与链接更新、2C 跨目录移动。本记录随各子阶段更新。

## 2A：持久身份与协调（2026-10-22）

### 交付内容

- [身份规则](../src/core/sync-identity.ts)：`<工作区>/.easym/sync/workspace.json`（schemaVersion 1，workspaceId + 相对路径 → documentId，可选 historyId 映射）的不可信解析、确定性编码与协调。协调规则：
  - 路径不变保留身份，永不按内容认亲。
  - 唯一的版本历史 ID 沿用；被多个文件或已记录文档共用（如复制目录、备份恢复）时暂停，选择“作为新文档”后生成新身份并保留 `historyId` 映射，不改写旧快照。
  - 大小写/Unicode 规范化冲突、跨平台不可保存的路径、历史无法校验的文档暂停接入。
  - 已记录文档找不到时保留身份；此时出现的未记录文件按“可能外部移动”暂停，只有用户显式选择“关联”“作为新文档”或“确认已删除”后才改变。
- [原生扫描与写入](../src-tauri/src/sync_identity.rs)：完整递归扫描（深度 32、10000 文档、50000 条目，超限报错而非截断）；目录不可读时扫描标为不完整；通过新的只读 `history::history_identities` 读取历史 ID，不触发历史恢复或写入；身份文件按预览时的摘要条件写入（缺失时 `persist_noclobber`），写前回读校验；停用只删除该文件。三个命令都在既有写入队列（Storage 锁）内执行。
- [前端流程](../src/platform/sync-identity.ts) 与 [同步身份对话框](../src/editor/IdentityDialog.tsx)：EM 菜单 →“同步身份”（需要桌面版并已打开工作区）。先预览、再启用/应用；扫描不完整、身份文件不可读或版本较新时停止；预览后身份被其他操作更改时提示冲突，不覆盖。

本子阶段不修改正文、`images.json`、版本历史或保存日志；身份尚未接入同步上传，也未在保存/另存时自动更新（另存为新文件由下一次扫描登记为新身份）。

### 验证

| 检查 | 结果 |
| --- | --- |
| `corepack.cmd pnpm typecheck` | 通过 |
| `corepack.cmd pnpm test --maxWorkers=2` | 60 个文件、367 项通过（新增身份规则 12 项、平台流程 5 项） |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 96 项通过（新增 5 项；符号链接用例仅在 Unix 运行） |
| `corepack.cmd pnpm build` | 通过 |
| `pnpm verify:sync-identity`（Edge，确定性 IPC） | 7 项通过，证据 [sync-identity-ui.json](verification/v2.0/step-2/sync-identity-ui.json)（SHA256 `1b2cbbab…bc38`） |
| `pnpm verify:commands`、`verify:workspace`、`verify:browser` 回归 | 通过 |

本机 Playwright 自带 Chromium 未安装，浏览器验证使用 `EASYM_TEST_BROWSER=msedge`。未运行原生 GUI 实机操作和 macOS/Linux 构建。
