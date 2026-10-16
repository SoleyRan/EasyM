# EasyM 1.0 验收与交付

2026-10-16，分支 `feature/v1.0`。收尾基线为 `main` 的 `3c40370`；首个收尾提交 `e4f4364` 已推送。用户已选择三平台同时正式发布、等待补齐实机验收，当前不公开正式 Release。

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

首轮 CI [38882947668](https://github.com/SoleyRan/EasyM/actions/runs/38882947668) 对应 `e4f4364`。后续新增 macOS DMG/Linux DEB 与三平台草稿收集的提交需要新的 CI，不把首轮结果替代新增流程验收。

下一轮 CI 必须完成三平台 Rust/构建/严格许可、Windows 原生/安装卸载/便携，以及 macOS app、Linux DEB 内完整许可资源逐文件比对。全部通过后可从同一提交运行 `Draft EasyM release`，输入成功 CI 的 run ID，校验版本/提交/包哈希后收集 NSIS、ZIP、DMG、DEB 和统一 SHA-256 到草稿；流程不会自动公开。

三平台 [实机验收表](Easy-Markdown-v1.0-实机验收.md) 仍待填写，签名/公证选择尚未确认。待它们完成后才能创建正式标签并公开 Release。当前已完成本机可执行的自动验收，未声称 1.0 正式发行。
