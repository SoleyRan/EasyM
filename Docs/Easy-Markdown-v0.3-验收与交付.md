# EasyM v0.3 验收与交付

日期：2026-10-13。分支：`feature/v0.3`。应用版本：`0.3.0`，界面 `v0.3.0-dev`。第六步提交 `67d45fd` 后进行第七步；本机包包含第七步未提交的版本/交付变更，以 [构建记录](verification/v0.3/acceptance-67d45fd/windows-build.json) 的源码树散列和产物散列为准，不能只用父提交还原包。

## 1. 阶段交付

本机开发交付已完成。新增 DOCX 办公导出、显式启用的持久版本历史/差异/恢复/清理、最多 100 实例的安全批量图片处理，以及键盘焦点/减少动画改进。PDF 实测评估完成，v0.3 保留系统打印，专用引擎延期。实现范围、配额与数据事务见 [设计计划](Easy-Markdown-v0.3-设计与实施计划.md)。

第七步统一版本、更新 Windows SBOM、补入 [体验指南](samples/v0.3/体验指南.md)，并完成下表本机验收。CI 保留前端和三平台桌面矩阵，新增版本一致性、Windows 原生启动/关闭、便携包逐文件散列校验与上传；前端单测限制为两个 Worker，与本机验证一致。**本步尚未 push，最新远程 CI 和 Windows 安装/卸载没有执行，不记为通过。**

## 2. 本机验收结果

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| 版本一致性、TypeScript、生产构建 | 通过 | package/Cargo/Cargo.lock/Tauri/界面/SBOM 均为 0.3.0；五个生产 Worker |
| 前端单测 | 31 个文件、173 项通过 | `pnpm.cmd test --maxWorkers=2`，保留既有 v0.1/v0.2 断言 |
| Windows Rust | 50 项通过 | 锁定依赖离线测试，覆盖 DOCX 保存、历史/图片事务、竞争与中断恢复 |
| 统一生产回归 | 15 组通过 | [汇总](verification/v0.3/acceptance-67d45fd/regression-verification.json)，包含新导出/历史/批图及旧功能/性能 |
| 慢速初始化 | 查找、模板各 6 倍 CPU 降速通过 | [查找](verification/v0.3/acceptance-67d45fd/search-slow-verification.json)、[模板](verification/v0.3/acceptance-67d45fd/templates-slow-verification.json) |
| DOCX 完整管线与界面 | 通过 | [管线](verification/v0.3/acceptance-67d45fd/docx-verification.json)、[界面](verification/v0.3/acceptance-67d45fd/docx-ui-verification.json)：当前未保存正文、缺图确认、取消/错误、后台 Worker、焦点、四主题、资源字节 |
| Microsoft Word | 5 样例打开、分页、编辑保存、再打开通过 | Word `16.0.20430.20146`；[报告](verification/v0.3/acceptance-67d45fd/word-verification.json)，普通办公样例 2 页、多页样例 25 页；不代表 WPS/LibreOffice 已通过 |
| 历史与批图 | 通过 | [历史](verification/v0.3/acceptance-67d45fd/history-verification.json)、[批图](verification/v0.3/acceptance-67d45fd/batch-images-verification.json)，生产 UI 使用受控桌面 IPC，真实磁盘事务由 Rust 测试覆盖 |
| 现有 HTML/打印媒体 | 通过 | [报告](verification/v0.3/acceptance-67d45fd/export-verification.json)，含内联 PNG、静态安全与 12 页 A4 PDF；系统打印调用仍为 stub |
| Windows Release | 离线锁定编译通过 | `cargo build --release --locked --offline --features custom-protocol` |
| Windows 原生窗口 | 独立 WebView2 配置启动及正常关闭通过 | [报告](verification/v0.3/acceptance-67d45fd/native-startup-verification.json)，不扩展为原生文件/打印验收 |
| NSIS 安装包 | 0.3.0 x64 生成通过 | 复用本地 NSIS 工具，3,572,719 字节；PE 版本及名称一致，未签名；未在本机安装 |
| 便携 ZIP | 245 项、所有暂存文件散列通过 | [报告](verification/v0.3/acceptance-67d45fd/portable-verification.json)，包含 v0.3 全部样例、Windows SBOM/清单与 234 份许可文本 |

构建仍有既有大 chunk 提示，单测有非阻断的 React act 提示；没有为消除提示而删减断言。第六步候选评估的 18 份 PDF/109 页结果保留在 [原报告](Easy-Markdown-v0.3-第六步-PDF引擎评估.md)，本步没有把候选集成或把旧报告更新为 0.3.0。

## 3. 性能

本机 Windows `10.0.26200`、Core 5 220H、31.7 GiB、Chromium `156.0.8078.4`。指标为事件到下一帧，不能代替真实 WebView/中文 IME；内存为采样值，有各自范围。

| 样例 | 结果 |
| --- | --- |
| 5 MiB 正文 | 打开 1820 ms；输入 p95 18.0 ms，达到 50 ms 目标 |
| 100 KiB 单行 | 打开 120 ms；输入 p95 24.8 ms，降级后全文/预览/撤销完整 |
| 100 张本地 800×600 图片 | 恢复并解码 415 ms，全部成功 |
| DOCX 约 3.65 MB 正文、100 引用 | 预检 4381 ms，生成下载 1970 ms；浏览器进程工作集采样峰值约 725 MiB |
| 100 个共享图片实例批处理 | 400×200 → 100×50，生成 2733 ms；帧间隔 p95 20.6 ms；工作集采样峰值约 415 MiB |
| 历史 5 MiB 小改动差异 | Worker 40.41 ms；无关联的 10,000 行触限后明确回退全文，未虚报逐行差异 |

[编辑性能](verification/v0.3/acceptance-67d45fd/performance-verification.json)、[差异性能](verification/v0.3/acceptance-67d45fd/history-diff-performance.json) 记录源规模和限制。共享图片样例不是 100 张大照片；浏览器多进程工作集可能重复计共享页、采样峰值是下界，不表示所有上限输入都能顺畅处理。

## 4. Windows 开发包

- 安装包：`src-tauri/target/release/bundle/nsis/EasyM_0.3.0_x64-setup.exe`，约 3.41 MiB。
- 便携包：`src-tauri/target/release/bundle/portable/EasyM-0.3.0-windows-x64-dev.zip`，约 4.71 MiB；解压后运行 `easym.exe`。
- Release exe：11,938,304 字节；产品名 EasyM、版本 0.3.0。

系统需 WebView2 Runtime；安装/便携包均为未签名开发候选。便携包带全部 `samples/`，NSIS 仅带项目/第三方许可；所有产物留在忽略的 target 中，不提交二进制到 Git。逐文件/锁文件/前端哈希及源码树见构建记录，主要 SHA-256：

| 产物 | SHA-256 |
| --- | --- |
| Release exe | `b008ef54f3a533b75178c12aac6f0b87fdc757ea2e2a13697fb168982eb6b98c` |
| NSIS | `b321da5ae0d2b751f16356b3cdefe226d4fe87d6aeec1f3de0775f19a24906fb` |
| ZIP | `cb9ab148734608efb452a54034064e103bb0b2b92e201338801ff2c7357f8f41` |

安装/卸载脚本只允许 disposable Windows CI runner，不能在日常电脑替换已有安装/注册表。三平台最新 CI 在第七步提交并 push 后验证；失败时修复并重新关联最终提交/产物，不能沿用 v0.2 的绿色运行记录证明 v0.3。

## 5. 许可差异

Windows 清单已按当前产品锁文件生成；应用 SBOM 版本更新为 0.3.0，无新增产品运行时依赖，Cargo.lock 仅更新 EasyM 自身版本。第六步 PDF 候选库和字体仍在隔离评估目录，不进入安装包或产品 SBOM。

| 目标 | 依赖版本数 | 完整许可文本缺项 |
| --- | ---: | ---: |
| Windows x86_64 MSVC | 430 | 0 |
| Linux x86_64 GNU | 526 | 0 |
| macOS aarch64 | 425 | 12 |

分目标摘要及 Cargo metadata hash 见本次证据目录的 `dependency-inventory-*.json`。本机筛选 metadata 和文本核验只证明清单，不代表跨平台编译或运行。macOS 的 block2/dispatch2/objc2/框架包仍需完整文本和 Apple SDK 派生许可复核；不拿通用 MIT 文本冒充上游版权授权。Windows/Linux 零文本缺项也不表示发行法律复核已完成。

## 6. 尚待完成的验收

| 项目 | 执行方 | 通过标准 |
| --- | --- | --- |
| 最新前端与三平台 CI、Windows 安装/启动/卸载 | 第七步 push 后由 CI | 当前版本/锁文件测试、编译及隔离安装卸载全部通过，保存运行链接与产物 hash |
| Windows 真实 IME、原生文件/导出对话框 | 用户实机 | 中文/空格路径、组合输入、另存/取消/外部冲突，原文和草稿不丢失 |
| Windows 原生历史/批图完整操作 | 用户实机 | 保存/重启/缺图/恢复/批处理/撤销/自动保存组合正确，原始资源不改写 |
| Windows 系统打印保存/取消 | 用户实机 | 长表格/代码/大图完整，返回编辑后可继续操作；候选评估不能代替系统面板 |
| WPS/LibreOffice 排版编辑 | 有对应明确版本软件的测试人员 | 冻结办公与降级样例可读、可编辑，不缺字/截图/丢内容 |
| Narrator/NVDA、VoiceOver/Linux 读屏与原生 GUI | 对应设备/辅助技术测试人员 | 名称、焦点、状态播报和键盘路径正确；不声明正式 WCAG 符合性 |
| macOS 许可与正式发行签名/公证 | 维护者提供身份/环境并复核 | 完整条款、SDK 来源和签名门槛通过 |

本轮不增加 DOCX 导入、云同步、完整三方合并、专用 PDF 集成或全工作区批图。历史是本机恢复能力，随目录共享会包含旧正文/图片；不替代设备备份。专用 PDF 后续集成先冻结字体/降级/分页/保存契约，不能把当前评估原型作为可用产品承诺。
