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

## 2B：受控重命名、回收站与链接更新（2026-10-22）

### 交付内容

- [链接重写](../src/core/link-rewrite.ts)：按 mdast 位置只替换链接、图片和引用定义的 URL 片段，保留 BOM、换行和其余字节；处理尖括号、带空格与百分号编码的路径和 `#锚点`；代码块、外链、页内锚点和越出工作区的链接不改动。
- [原生操作](../src-tauri/src/workspace_ops.rs)：
  - 同目录重命名。先写 `.easym/sync/operations/<op>/` 日志和暂存正文，再以不覆盖的方式改名（提交点）。之后依次更新版本历史索引键、同步身份路径和其他文档的链接，每一步都可幂等前滚；崩溃时，提交前的日志直接丢弃，提交后的日志继续完成。
  - 仅大小写不同的改名经临时名完成，按精确文件名判断提交状态。
  - 以下情况拒绝改名：目标已存在、跨目录、文件名无法跨平台保存、文档有未完成的保存日志、新名称已有版本历史、文档正在标签页中打开。
  - 链接更新带预览时的版本；任一文档被并发修改则在改名前放弃。前滚时若文档已被修改，则跳过并提示，不覆盖。
  - 回收站：移到 `.easym/trash/<op>/`，记录原路径和同步身份；恢复时不覆盖已有文件，并在可能时恢复原身份。图片和版本历史不动。
- 配套辅助：`history::rename_key`/`check_rename`、`transaction::pending`、`merge::record_names`、`Recents::relocate`。
- 界面：工作区文件树右键“重命名…”（先预览受影响的链接，再确认）、“移到回收站”（需确认）；侧栏新增“工作区回收站”。仅桌面版提供。

已打开的文档需先关闭标签页再重命名或删除，避免编辑器的名称、草稿和版本与磁盘不一致。合并恢复记录仍按原文件名列出（记录不可改写），改名后会提示。跨目录移动在 2C 实施。

### 验证

| 检查 | 结果 |
| --- | --- |
| `corepack.cmd pnpm typecheck` | 通过 |
| `corepack.cmd pnpm test --maxWorkers=2` | 62 个文件、377 项通过（新增链接重写 7 项、平台流程 3 项） |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 104 项通过（新增 8 项：保留身份/历史/字节、拒绝场景、大小写改名、并发修改、提交前后崩溃、前滚不覆盖、保存日志阻止、回收站） |
| `corepack.cmd pnpm build` | 通过 |
| `pnpm verify:workspace-ops`（Edge，确定性 IPC） | 6 项通过，证据 [workspace-ops-ui.json](verification/v2.0/step-2/workspace-ops-ui.json)（SHA256 `19f2182b…1d91`） |
| `verify:workspace`、`verify:commands`、`verify:sync-identity`、`verify:context-menu`、`verify:browser` 回归 | 通过 |
