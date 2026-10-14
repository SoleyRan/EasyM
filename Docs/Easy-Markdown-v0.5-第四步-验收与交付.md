# EasyM v0.5 第四步：验收与交付

日期：2026-10-14。分支 `feature/v0.5`，基线 `d1abdf6`。本步统一产品版本至 `0.5.0`，前三步历史证据保持原版本不改写。第四步实现及本机开发包验收已完成，改动尚未提交；远端 CI 与人工发行门槛另列。

## 本步改动

使用导引继续保持四页及前后箭头，补充最近打开、重启恢复、草稿确认与另存、外部冲突比较和本地数据边界。版本变化后自动展示一次，同版本确认后不重复，可从设置重新打开。

新增独立 [v0.5 样例目录](samples/v0.5/README.md)，保留原有编辑、办公导出和安全样例，新增 [持续写作与恢复](samples/v0.5/持续写作与恢复.md) 的操作及故障说明。样例图片保持已有项目资产原字节；只借鉴 MarkText 交互设计，未复制其源码、资源或文案。

修复 Windows 验收隔离边界：显式指定 `WEBVIEW2_USER_DATA_FOLDER` 时，原生最近索引也放入该配置的 `.easym/`，防止冒烟测试重开真实用户文件或改写其会话。普通启动仍使用系统应用数据目录。实机 smoke 同时发现初次导引会吞掉 OS 关闭请求，已修复为关闭导引后沿用未保存/忙碌保护，不自动记录为导引已读；新增初次启动退出与手动导引下脏文档保护测试。新增 Rust 测试证明默认目录、独立目录、拒绝相对路径及原记录不被改写；启动脚本检查新配置无已有最近文件和工作区，再正常关闭。

`package.json`、Cargo/锁文件、Tauri、界面标识及 SBOM 应用版本一致为 `0.5.0`。从锁定依赖重新生成 Windows 清单：430 个依赖版本、234 份许可文件，缺项为 0；与上一步比没有依赖增删或声明许可变化，见 [比较报告](verification/v0.5/step-4/dependency-comparison.json)。macOS 既有 12 项完整许可文本缺口仍待补全及发行复核，不把 Windows 清单当作全部平台清单。

## 本机验收

命令由此 Windows 工作区 PowerShell 执行；浏览器检查使用独立的无头 Chromium 配置和生产 `dist`。原生 IPC fixture 验证界面流程，文件系统授权、版本与安全边界另由 Windows Rust 测试覆盖，不能代替系统对话框和真实用户输入。

已通过 45 文件 / 252 项前端测试、65 项 Windows Rust 测试、类型检查、生产构建及版本一致性检查。23 组生产回归全部通过，最终回归于北京时间 16:53:09–16:57:12 执行。5 MiB 正文和 100 KiB 单行各测 40 次输入，事件到下一帧 P95 为 17.5/17.4 ms（目标均 ≤50 ms），打开耗时 1720/85 ms；另覆盖 2,000 单元格表格、选区浮层、100 图片及 20 MiB 图片边界。6 倍 CPU 降速的查找/模板初始化检查通过。Word 16.0.20430.20146 的 5 份 DOCX 均成功打开、分页、编辑并重开；原生窗口隔离启动/正常关闭与便携包 247 项归档校验通过。四页导引在最小 960×680 窗口内导航可见且无横向溢出。最终结果见 [验收汇总](verification/v0.5/step-4/acceptance-summary.json)。

原始完整日志保留在 `test-results/v05-step4/`，不上传 Git；其摘要和散列、生产构建/源码树/包散列另存于 `Docs/verification/v0.5/step-4/`。重新记录时先运行 `node scripts/record-build.mjs Docs/verification/v0.5/step-4`，再运行 `node scripts/record-v05-acceptance.mjs`，后者核对版本、测试数量、当前构建与安装/便携包散列，拒绝缺失或失败证据。

全量回归以 `regression.log` 和 `regression-verification.json` 的起止时间及 `distIndexSha256` 关联实际构建，避免用旧版报告证明新版。

## Windows 开发包

已生成并核验名称/版本为 EasyM 0.5.0 的 Windows 产物：

- 安装包：`src-tauri/target/release/bundle/nsis/EasyM_0.5.0_x64-setup.exe`。
- 便携包：`src-tauri/target/release/bundle/portable/EasyM-0.5.0-windows-x64-dev.zip`。
- Release：`src-tauri/target/release/easym.exe`。

包未签名，需要系统 WebView2 Runtime。安装包为 3,677,523 字节，便携包为 5,117,466 字节。便携 ZIP 附项目许可、第三方清单/文本及 v0.5 全部样例，逐文件验证归档字节。它是免安装开发包，草稿与最近索引仍保存在此设备的应用存储，并不自动随 ZIP 搬迁。

本机只构建安装包，不替换日常安装。安装/卸载脚本限定 disposable Windows CI runner；当前源码未推送，三平台 CI 及本次安装/卸载仍待推送后执行。最终源码和产物散列见 [构建记录](verification/v0.5/step-4/windows-build.json)。

## 后续人工及远端门槛

1. 推送后确认前端和 Windows/macOS/Linux CI 全部通过，检查 Windows 安装、启动与卸载报告；Unix 专属符号链接测试由对应 runner 执行。
2. 用样例临时副本在真实 Windows WebView 检查中文 IME、系统打开/另存/导出/打印取消、多标签正常退出和重新启动，以及发生外部写入后的保留/比较/另存路径。
3. 对未保存正文、表格输入和图片配方分别检查冲突；检查权限撤销、移动/删除目标后仍能另存本地副本。异常退出前先备份临时数据，不在日常文档上模拟崩溃。
4. 指定设备验收 macOS/Linux GUI、读屏和键盘；指定 WPS/LibreOffice 版本验收实际分页。Word COM 检查仅覆盖其打开、结构、分页及编辑重开。
5. 补齐 macOS 许可文本和 SDK/依赖发行复核，完成发行签名、公证及更新策略；本轮没有启用自动更新。

v0.5 交付目标是本机验收的开发候选；上述待验收项明确保留，不称为正式跨平台发行。
