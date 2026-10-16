# EasyM 1.0 验收与交付

2026-10-16，分支 `feature/v1.0`。收尾基线为 `main` 的 `3c40370`；收尾提交 `e4f4364`、三平台候选提交 `7086745` 已推送。用户已选择三平台同时正式发布、等待补齐实机验收，当前不公开正式 Release。

## 已完成的本机检查

证据入口为 [验收摘要](verification/v1.0/local/acceptance-summary.json)、[逐文件哈希清单](verification/v1.0/local/manifest.json) 及 [构建记录](verification/v1.0/local/windows-build.json)。本轮重新运行，不沿用旧版通过状态。

| 项目 | 结果 |
| --- | --- |
| TypeScript / 生产构建 | 通过；保留已有大分块警告 |
| 前端单测 | 55 个文件、316 项通过 |
| Windows Rust | 91 项通过，`--locked --offline` |
| 生产功能回归 | 31 组通过，包含升级导引、合并和备份样例 |
| 慢速交互 | 焦点、查找、模板、公式，六倍 CPU 降速均通过 |
| 性能 | 5 MiB 文本输入 p95 17 ms；100 KiB 单行 16.6 ms，均低于 50 ms；表格/100 张图片/20 MiB 边界通过 |
| Windows 原生 | 隔离配置的窗口启动/正常关闭、真实 WebView2 离线扩展均通过 |
| Word | Word 16 的 5 个办公 DOCX + 1 个混合扩展样例打开、编辑、保存、重开及 PDF 导出通过 |
| Windows 包 | NSIS 生成；便携 ZIP 323 个条目逐文件哈希通过，含 1.0 全套样例 |
| 依赖文本库存 | Windows 563 / macOS 558 / Linux 659 个依赖版本，文本缺项均为 0，来源与哈希核验通过；Apple SDK 分发复核独立保留 |
| 发布校验 | Windows/macOS/Linux 候选校验的拒绝测试通过：更改字节、错误提交/目标、缺少资源或安装验收均不能生成可发布候选 |

新版 Edge 下载中心的 `edge://` 内部请求曾被 DOCX 脚本误报为外网请求；已排除浏览器内部页面，仍拒绝真实外部请求，完整回归重跑通过。原始失败日志在本机 `test-results/v10/regression-edge-internal-failure.txt`。

自动浏览器测试使用生产构建和隔离配置；原生检查使用同一 Windows 可执行文件。模拟桌面 IPC 不能证明真实输入法/选择器已通过；Word 结果不替代其他办公软件或 macOS/Linux 排版。

## 本机候选

- NSIS：`src-tauri/target/release/bundle/nsis/EasyM_1.0.0_x64-setup.exe`，5,378,740 字节，SHA-256 `77d26b5c027f774237b50881df3636f61f3a3839f5e8930d7f7c450b79866ea2`。
- ZIP：`src-tauri/target/release/bundle/portable/EasyM-1.0.0-windows-x64.zip`，6,946,874 字节，SHA-256 `97ac8e00ee183b6cf644720dbf2590e90428a1ad367e368051d3de25b37af59f`。
- 可执行文件版本为 1.0.0，SHA-256 `820aed5f956f7a8eaf3e3e5cc04cb44ec56cc008194dbd0bdc91ee0842c18dd1`。

候选为未签名本机产物，构建时存在未提交收尾文件；证据记录源码树哈希与具体文件，不伪称来自最终干净发行提交。正式草稿只使用成功 CI 同一提交的三平台候选；最终哈希以该次 CI manifest 为准，不与本机包混用。本机不执行安装/卸载，以免替换现有安装；该检查仅在一次性 Windows runner 执行。

## 远程与实机验收

候选 CI [38883944619](https://github.com/SoleyRan/EasyM/actions/runs/38883944619) 对应完整提交 `70867453976b1551ac3540b797a6e1c23310cd7d`，四个 job 全部成功。前端 55 文件/316 测试、31 组生产回归、四项慢速检查通过；Windows Rust 91 项、macOS/Linux Rust 各 97 项通过。三平台严格许可检查无文本缺项，Windows 原生/离线扩展/安装卸载/便携检查、macOS app/DMG、Linux DEB 及包内许可逐文件比对均通过。

已下载三个 release-candidate 和浏览器/Windows 验收 artifact。五个外层 ZIP 的 SHA-256 与 GitHub API digest 一致；三个平台候选的版本、提交、文件大小及逐文件哈希再次校验通过。48 份 CI 元数据、manifest、校验和及 JSON 报告保存在 [CI 证据](verification/v1.0/ci-7086745/manifest.json)，与本机历史证据分开。此后的文档提交不改变候选绑定的提交。

| 候选 | 下载 | 包文件 SHA-256 |
| --- | --- | --- |
| Windows NSIS / ZIP | [Windows artifact](https://github.com/SoleyRan/EasyM/actions/runs/38883944619/artifacts/12038957634) | NSIS `d95276d4a5404cc50503a55f0f62124f80b6a8e924b6f262726f6f691a1113de`；ZIP `f483b2fc57083b0ccef429fe8dc8de8f18dd86fbdd26b1036d989a429579a9f0` |
| macOS Apple Silicon DMG | [macOS artifact](https://github.com/SoleyRan/EasyM/actions/runs/38883944619/artifacts/12038857504) | `192e3ec296b6de75919b74e658391db28ec51a7632b9a7b766a5c5a764be7a9e` |
| Ubuntu 24.04 x86_64 DEB | [Linux artifact](https://github.com/SoleyRan/EasyM/actions/runs/38883944619/artifacts/12039276331) | `c386fbbab80b8a2f26dda8750fb7fe7507a1926092e9893ca79f43c04c920f4a` |

本机已解压到 `test-results/v10/ci-7086745/{windows,macos,linux}/`，该目录不上传 Git。GitHub artifact 当前过期时间为 2027-01-14，下载可能需要登录；它们是验收候选，不是正式 Release 资产。

`Draft EasyM release` 已编写并完成候选校验测试，尚未远程运行或创建草稿。GitHub 手动工作流需要先进入默认分支。合并 main 后若提交 SHA 改变，须等待 main 该提交的 CI 全绿，再针对该提交运行工作流并输入其 run ID；不能把旧候选标为来自新提交。本次 run ID `38883944619` 仅绑定候选提交 `7086745`，不能与后续文档提交或合并提交混用。流程收集 NSIS、ZIP、DMG、DEB 和统一 SHA-256，只创建草稿，不会自动公开。

三平台 [实机验收表](Easy-Markdown-v1.0-实机验收.md) 仍待填写，签名/公证选择尚未确认。待它们完成后才能创建正式标签并公开 Release。当前已完成本机可执行的自动验收，未声称 1.0 正式发行。
