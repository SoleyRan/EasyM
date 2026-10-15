# v0.6 第四步：验收与交付

开始日期：2026-10-15。第三步已提交 `744d9f7`，本次按用户指令提交第4步改动及验收证据，不自动 push。

## 冻结范围

统一产品版本为 0.6.0，补齐四页使用导引、设置与导出说明、v0.6 样例和 Windows 许可/SBOM。验证四种扩展混排时的预览、HTML、打印和 DOCX，并验证当前源文不因导出而变化。保留现有格式、历史、恢复、图片与外部冲突功能的完整回归。

| 扩展 | 预览 / HTML / 系统打印 | 可编辑 DOCX |
| --- | --- | --- |
| 脚注 | 文末说明；HTML/预览保留内部往返链接 | 上标编号与文末脚注，非 Word 原生逐页脚注 |
| Front Matter | 带围栏的静态原文，不解析配置 | 静态完整原文 |
| 数学公式 | 离线静态 MathML；关闭、错误或超限保留源码 | 原始 LaTeX 与预检提示 |
| Mermaid | 清理后 SVG data 图片与完整源码；固定浅色导出 | 完整可编辑围栏与预检提示 |

不引入新的 PDF 引擎、公式 Word OMML 或原生可编辑图形。HTML 需要现代 MathML 浏览器。图表仅保证流程图和时序图，不扩大第三步的输入/输出限额和安全边界。

## 本步实现

产品、Cargo/锁文件、Tauri、界面标识和 SBOM 版本统一为 `0.6.0`。四页使用导引保留左右箭头，最后一页补充扩展语法、设置开关与导出差异；设置、DOCX 预检和打印预览同步说明。首次启动或版本变化时展示导引，同版本确认后不重复。

新增 [v0.6 样例目录](samples/v0.6/README.md)，提供四种扩展、表格与本地图片的混排样例，保留编辑、办公导出、恢复和安全体验指南。仅借鉴 MarkText 设计，没有复制其源码或资源。Windows 清单重新生成并校验：563 个依赖版本、296 份许可文本，缺项 0。

新增混排交付检查并纳入统一回归：实际下载 HTML/DOCX、生成浏览器打印 PDF，核对本地图片、表格、内部脚注锚点、静态 MathML 和图表图片；关闭两个渲染开关后检查源码回退，导出前后正文一致。HTML 以本地文件打开，无执行脚本或外部请求。

新增真实 Windows WebView2 扩展检查：使用独立进程、临时配置与本机调试端口，保持生产 CSP，验证实际 `http://tauri.localhost` 下的离线资源、Mermaid 沙箱、公式、脚注、四主题、阅读/即时渲染及正常退出。没有模拟原生 IPC；该检查已接入 Windows CI。

## 本机验收

本轮命令在当前 Windows PowerShell 工作区运行；生产浏览器使用独立无头 Chromium 156.0.8078.4，真实桌面检查使用 WebView2 155.0.4283.45。提交前生成的第4步结果见 [验收汇总](verification/v0.6/step-4/acceptance-summary.json)，其中源码基线及未提交标记记录验收发生时的状态，保留原始记录。

| 检查 | 实测结果 |
| --- | --- |
| 类型、版本、生产构建 | 全部通过；Windows Release 与安装包产品版本均为 0.6.0 |
| 前端单测 | 49 文件，279 项通过 |
| Windows Rust | `--locked --offline`，65 项通过 |
| 生产完整回归 | 27 组全部通过，2026-10-15 UTC+8 11:48:49–11:54:13 |
| 输入性能 | 5 MiB 文本 / 100 KiB 单行各 40 次；输入到下一帧 p95 为 17.5 / 17.0 ms，均低于 50 ms 目标；打开耗时 1812 / 108 ms |
| 其他性能与慢速环境 | 2,000 单元格、选区浮层、100 图片、20 MiB 边界；6 倍 CPU 降速查找/模板检查通过 |
| 四页导引 | 960×680 最小窗口下导航可见、无横向溢出，左右箭头及版本说明通过 |
| 实际 Word | Microsoft Word 16.0.20430.20146；原有 5 份及混排 1 份 DOCX 均打开、分页、导出 PDF、编辑保存并重开成功；混排为 2 页、1 表、1 图，公式及图表源码完整 |
| 原生 Windows | 隔离启动、最近索引隔离、扩展离线显示、四主题、阅读退出和正常关闭通过 |
| 包与许可 | NSIS 构建通过；便携 ZIP 的 313 项内容逐文件校验；Windows 许可文本无缺项 |

首次生产回归发现 Mermaid 验证脚本在阅读模式尚未进入时提前按 Esc，已改为等待进入/退出状态后再继续；最终重跑全部 27 组通过。初次失败诊断留在本机 `test-results/v06-step4/regression-first.log`，不以失败前的局部结果替代完整验收。

完整本轮日志已归档至 [logs](verification/v0.6/step-4/logs/)，截图在 [screenshots](verification/v0.6/step-4/screenshots/)，可直接检查 [混排 HTML](verification/v0.6/step-4/exports/combined.html)、[浏览器 PDF](verification/v0.6/step-4/exports/combined.pdf)、[DOCX](verification/v0.6/step-4/exports/combined.docx) 和 [Word PDF](verification/v0.6/step-4/exports/combined-word.pdf)。其余导出文件散列见 [导出产物清单](verification/v0.6/step-4/export-artifacts.json)。

[构建记录](verification/v0.6/step-4/windows-build.json) 关联当前基线 `744d9f7`、未提交源码树散列、生产资产、可执行文件与安装/便携包散列；[生产回归报告](verification/v0.6/step-4/regression-verification.json) 记录实际运行时间和 `dist/index.html` 散列。归档命令先运行 `node scripts/record-build.mjs Docs/verification/v0.6/step-4`，再运行 `node scripts/record-v06-acceptance.mjs`，后者检查当前报告、Word 样例数量、版本及包字节。

## Windows 开发包

已生成以下未签名开发包，运行需要系统 WebView2 Runtime：

| 产物 | 大小 | SHA-256 |
| --- | --- | --- |
| `src-tauri/target/release/bundle/nsis/EasyM_0.6.0_x64-setup.exe` | 5,192,808 字节 | `c554314cb39971ec2cc466e1c46323686d95fcee55d1f8addddb0d4cf553858d` |
| `src-tauri/target/release/bundle/portable/EasyM-0.6.0-windows-x64-dev.zip` | 6,681,324 字节 | `a504bf1eed6ee1c2ae7ca86cdda0667450fd8bb62e25d8ae2f5d00f2ef9d1118` |
| `src-tauri/target/release/easym.exe` | 13,950,976 字节 | `23abd3949f647f2edcb4b3580c655e71ff3b556bfab16ef0a455e507464ae0c1` |

便携包附项目许可、第三方许可与全部 v0.6 样例；解压运行 `easym.exe`。草稿、会话和最近索引仍保存在设备应用数据目录，不自动随 ZIP 搬迁。本机只构建安装包，不覆盖日常安装。

## 交付边界

第4步实现与本机自动验收完成，本次提交包含交付改动及证据。当前未 push，三平台 CI 与 disposable Windows runner 安装/卸载尚未运行。真实 IME、原生保存/系统打印、屏幕阅读器、macOS/Linux GUI、指定 WPS/LibreOffice 排版、跨平台许可复核和签名/正式发行仍需对应设备或后续流程验收。macOS 既有 12 项完整许可文本缺口仍为发行门槛，Windows 清单不代替其他目标平台清单。浏览器 PDF 与 Word COM 检查不等于系统打印或全部办公软件分页验收。
