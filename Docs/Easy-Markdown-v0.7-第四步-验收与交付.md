# v0.7 第四步：验收、帮助与交付

开始日期：2026-10-16。第3步已提交 `25b88ef`（`feat: add portable document backup and restore`），当前分支 `feature/v0.7`。本步改动随本次 v0.7 交付提交。

## 本步范围

统一 package/Cargo/锁文件/Tauri/UI/SBOM 的产品版本为 `0.7.0`，不变更依赖版本。保留四页左右箭头导引，第3页补充三方合并、应用前强制归档、合并恢复入口及文档备份恢复；版本变化后重新显示，同版本确认后不重复。

[v0.7 样例](samples/v0.7/README.md) 提供可组合与同段冲突的 B/L/R、预期结果、含 PNG 的备份文档与逐步操作说明。新增生产交付检查验证版本导引、最小窗口、真实合并/资源 Worker 和样例一致性，并纳入统一回归及 CI 产物。仅借鉴 MarkText 设计，没有复制其源码或资源。

## 使用与恢复

有可靠基线时从外部版本比较分析三方合并，逐块选择本地、磁盘或手工结果，审查候选、确认格式后应用。先强制保存 B/L/R/候选，再按磁盘 revision 条件写入；归档失败或磁盘再次变化不提交。EM → 合并恢复记录可恢复副本，记录存在不代表提交成功。原有本地图片字节无法验证时阻止合并，请先另存本地副本。详见 [第2步](Easy-Markdown-v0.7-第二步-冲突选择与安全应用.md)。

EM → 文档备份与恢复创建 `.easym-backup.zip`，保存面板打开时的正文（含未保存编辑）、支持的本地图片和可选的当前文档已登记历史。恢复先校验并明确确认，再选择父目录，生成独立 `EasyM-restored-UUID` 目录；通过 EM → 打开文件查看副本。不覆盖当前文件、编辑内容或原包。远程图片仅保存链接；历史位置配置、其他文档和合并恢复记录不纳入。备份应复制到独立存储。详见 [第3步](Easy-Markdown-v0.7-第三步-文档备份与恢复.md)。

## 本机验收

本次检查全部在当前 Windows 工作区运行，使用本步新生产构建。证据入口为 [验收摘要](verification/v0.7/step-4/acceptance-summary.json)、[逐文件哈希清单](verification/v0.7/step-4/manifest.json) 和 [构建/产物记录](verification/v0.7/step-4/windows-build.json)。

| 检查 | 本次结果 |
| --- | --- |
| TypeScript / 前端单测 | 通过；55 个测试文件、316 项测试，[日志](verification/v0.7/step-4/logs/unit.txt) |
| Windows Rust | `--locked --offline`，91 项通过，[日志](verification/v0.7/step-4/logs/rust.txt) |
| 完整生产回归 | [31 组全部通过](verification/v0.7/step-4/regression-verification.json)，含合并、备份与新的交付专项；[完整日志](verification/v0.7/step-4/logs/regression.txt) |
| 导引与分发样例 | [3 组通过](verification/v0.7/step-4/protection-delivery-verification.json)：0.6 升级导引、确认持久化/设置重开、真实 Worker 检查合并/备份资源样例；[960×680 第3页截图](verification/v0.7/step-4/screenshots/protection-delivery/guide-3.png) |
| 慢速浏览器 | 6 倍 CPU 降速的焦点、查找、模板、公式检查全部通过，分别归档 `*-slow-verification.json` 及日志 |
| 性能 | [通过](verification/v0.7/step-4/performance-verification.json)：5 MiB 文本输入 p95 为 15.9 ms，100 KiB 单行 17.1 ms，均满足 50 ms；表格、选区、100 张本地图片与 20 MiB 边界检查通过 |
| Windows 原生 | [独立配置启动/正常关闭](verification/v0.7/step-4/native-startup-verification.json) 与 [真实 WebView2 离线扩展](verification/v0.7/step-4/native-extensions-verification.json) 通过；后者覆盖四主题/阅读/即时渲染，不含原生备份选择器 |
| Word | Word 16.0.20430：5 个办公 DOCX 与 1 个混合扩展样例打开、编辑、保存、重开和 PDF 导出通过，[办公报告](verification/v0.7/step-4/word-verification.json) / [扩展报告](verification/v0.7/step-4/word-extensions-verification.json) |
| 版本 / 许可 | package、Cargo、锁文件、Tauri、UI、SBOM 一致为 0.7.0；Windows 563 个依赖版本、296 份许可文件，缺失 0；无运行时依赖变更 |
| Windows 构建 / 便携包 | Release + NSIS 成功；[便携包](verification/v0.7/step-4/portable-verification.json) 315 个条目逐文件哈希通过，内置 v0.7 样例，可执行文件与原生验收一致 |

复核入口：`pnpm verify:regression` 跑 31 组；`pnpm verify:performance` 和四个 `pnpm verify:<focus/search/templates/math> --slow` 分别运行。完成新构建、原生/Word/便携包检查后，用 `node scripts/record-build.mjs Docs/verification/v0.7/step-4` 和 `node scripts/record-v07-acceptance.mjs` 归档。归档器核对本次报告的时间范围、构建哈希、包版本和可执行文件哈希；Worker 输出在完整回归日志中。Word 脚本成功时没有标准输出，其两份 `.txt` 日志保存本次 JSON 报告。原有全仓 Rust 格式差异未整体重排，不声称格式检查通过。

## 交付与剩余门槛

本机开发包：

- 安装包：`src-tauri/target/release/bundle/nsis/EasyM_0.7.0_x64-setup.exe`，5,372,294 字节，SHA-256 `332a1f9c860acb22ce02a7e13bd370321ccc316d6f75dbbef2177dd851d5e91c`。
- 便携包：`src-tauri/target/release/bundle/portable/EasyM-0.7.0-windows-x64-dev.zip`，6,924,414 字节，SHA-256 `5dabe9d168d8056a37a1fdc2bdc50ecc9e26525162e74d723185faf6d487e667`。
- 主程序版本 0.7.0，SHA-256 `647d25262730c31481738404cb4700d98e15bdd9dfdad268f429ddd79f65c8be`；[包元数据](verification/v0.7/step-4/package-metadata.json) 记录实际版本与大小。

原生启动与扩展检查使用独立 WebView2/最近文件配置，不读取用户日常草稿。安装/卸载检查按既有脚本仅在 disposable Windows CI runner 上执行，本机未执行。包体保留现有前端大分块警告，构建成功。

以上证据生成于提交前的本机验收，不包含远程 CI 结果；三平台 CI 等本次提交推送后验证。本机不能代替 macOS/Linux GUI、真实 IME、原生文件/目录/打印选择器、读屏与签名发行复核。继承的 macOS 许可全文门槛独立记录。功能与本机自动检查完成不等于正式发行。

四步功能开发与本机自动验收已完成。本次提交后推送 `feature/v0.7` 将触发三平台 CI，再用开发包按 [体验指南](samples/v0.7/体验指南.md) 完成人工验收；远程检查与人工项通过后再判断合并/发行。
