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

2B 交付时，已打开的文档需先关闭标签页才能重命名；2C 已放宽为无未保存修改即可（见下）。合并恢复记录仍按原文件名列出（记录不可改写），改名后会提示。

### 验证

| 检查 | 结果 |
| --- | --- |
| `corepack.cmd pnpm typecheck` | 通过 |
| `corepack.cmd pnpm test --maxWorkers=2` | 62 个文件、377 项通过（新增链接重写 7 项、平台流程 3 项） |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 104 项通过（新增 8 项：保留身份/历史/字节、拒绝场景、大小写改名、并发修改、提交前后崩溃、前滚不覆盖、保存日志阻止、回收站） |
| `corepack.cmd pnpm build` | 通过 |
| `pnpm verify:workspace-ops`（Edge，确定性 IPC） | 6 项通过，证据 [workspace-ops-ui.json](verification/v2.0/step-2/workspace-ops-ui.json)（SHA256 `19f2182b…1d91`） |
| `verify:workspace`、`verify:commands`、`verify:sync-identity`、`verify:context-menu`、`verify:browser` 回归 | 通过 |

## 2C：跨目录移动与打开中文档的重命名（2026-10-23）

### 交付内容

- 移动（工作区树右键“移动到…”，选择工作区内已有的目录）。在提交点前完成全部复制，且只做添加：
  - 正文引用的 EasyM 管理图片（`assets/img-*`、`assets/.originals/img-*`）复制到目标目录，`images.json` 中对应的实例合并过去（[`copy_resources`](../src-tauri/src/workspace_ops.rs)）。目标已有同名图片时，字节必须完全相同，否则以 `resource_conflict` 拒绝。源目录的图片保留，不删除。
  - 版本历史通过 `history::portable_history`（备份所用的同一导出）复制，再由 `history::import_history` 导入目标目录；对象按内容寻址，不覆盖已有对象。
  - 提交后，源目录的历史条目改为已停用的孤立条目 `history-moved-<id>.md`（`forget_history`），既不再占用原文件名，也不让源目录历史失效。
  - 提交前崩溃时，`abandon_import` 撤销目标目录中的导入条目；提交后崩溃则继续前滚。
- 链接：被移动文档里的相对链接改为从新位置解析（管理图片保持原相对路径，因为已随文档复制）；其他文档中指向它的链接同步更新；已能正确解析的链接按字节保持不变。
- 拒绝场景新增：目标目录不存在、目标在隐藏目录（如 `.easym`）内、目标文件名已有版本历史、引用的图片缺失或越出文档目录。
- 打开中的文档：重命名或移动不再要求关闭标签页。只要所有标签页都没有未保存修改、正在进行的操作或待确认的图片，就允许执行。原生会话跟随文件移到新路径，标签页按原会话重新加载正文、版本、名称和工作区路径。删除仍要求先关闭标签页（否则下次保存会在原位置重建文件）。
- 打开工作区时，先前滚或丢弃崩溃遗留的重命名/移动日志；失败时在工作区警告中提示。
- 新命令 `workspace_directories`：列出可作为移动目标的目录，不含隐藏目录和 `node_modules`，深度 32、上限 50000 项。

### 验证

| 检查 | 结果 |
| --- | --- |
| `corepack.cmd pnpm typecheck` | 通过 |
| `corepack.cmd pnpm test --maxWorkers=2` | 62 个文件、379 项通过（新增移动规划 2 项） |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 109 项通过（新增 5 项：复制图片/元数据/历史且保留源图、目标图片冲突不改动、提交前崩溃撤销导入/提交后崩溃完成、隐藏/缺失目录与已占用历史名拒绝、目标目录列表） |
| `corepack.cmd pnpm build` | 通过 |
| `pnpm verify:workspace-ops`（Edge，确定性 IPC） | 8 项通过（新增：移动预览、移动后双向链接和打开中标签页重新加载），证据 [workspace-ops-ui.json](verification/v2.0/step-2/workspace-ops-ui.json)（SHA256 `f6552bcc…b7e`） |
| `verify:workspace`、`verify:commands`、`verify:sync-identity`、`verify:context-menu`、`verify:browser`、`verify:history` 回归 | 通过 |

未运行原生 GUI 实机操作和 macOS/Linux 构建。界面验证使用确定性 IPC，原生文件系统语义由 Rust 测试覆盖。

### 第 2 步交接

第 2 步全部完成：持久身份与协调（2A）、同目录重命名与回收站（2B）、跨目录移动与打开中文档的重命名（2C）。已知限制：
- 合并恢复记录按原文件名保存且不可改写，移动或重命名后仍列在旧名下。
- 移动不会删除源目录中的图片和历史对象（首发不做回收）。
- 非 EasyM 管理的相对图片（如 `photo.png`）不复制，只改写链接指向原位置。

第 2 步合并 main 后，从 main 创建 `feature/v2.0-step-3-sync`：凭据、首次配对、推送/拉取、持久队列与本地对象缓存。
