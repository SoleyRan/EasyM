# v0.6 CI 修复验证（2026-10-15）

对应失败运行：https://github.com/SoleyRan/EasyM/actions/runs/38688482350

修复基于 `5ec44585e83388dbd05bd7c26290363132f1d5b5` 的工作区。此记录是本地补充验证，不替代 GitHub CI 重跑结果，也不修改此前阶段验收记录。

## 前端 DOCX 验收

失败位置是 `verify-docx.mjs` 等待 `window.docxAcceptance` 超时。Vite 应用配置已有 `main`、`mermaid` 两个 HTML 入口，验收脚本只指定 `lib.entry`，没有覆盖 `rollupOptions.input`，干净输出目录不会生成预期的 `entry.js`。本地旧版 `entry.js` 因 `emptyOutDir: false` 留存，导致本地误通过。

修复为显式覆盖构建入口，并在每次验收前清理该脚本自己的输出目录；增加入口产物断言和页面错误、控制台错误、失败请求、HTTP 错误记录。

Node 22.23.3 下验收通过，10 项检查、16 个 Worker 均正常结束。见 `docx-verification.json`。

## Windows 原生扩展验收

失败运行只记录调试端口 30 秒内未就绪，没有底层连接错误或 WebView 进程信息。相同失败未在本机复现，因此不能据此断言云端失败的确切原因。

原脚本先由临时监听器申请端口再释放，最后才启动 WebView2，存在端口再次被占用的窗口。改为 WebView2 使用 `--remote-debugging-port=0` 分配并持有端口，从本次隔离配置目录的 `DevToolsActivePort` 读取实际端口；仍只连接回环地址。保留 30 秒启动期限，新增应用提前退出检测、实际连接错误、Node/WebView 版本、进程状态与隔离 WebView 日志，CI 在失败时也上传日志。

Node 22.23.3、Windows 本机 WebView2 155.0.4283.45 下通过全部原生检查，应用正常退出且退出码为 0。见 `native-extensions-verification.json`。使用已有 release 可执行文件，未修改产品代码、CSP 或测试断言；云端 Windows Server 环境仍需提交后 CI 重跑确认。

## 完整回归

`pnpm verify:regression` 在 Node 24.20.0 / Chromium 156.0.8078.4 下完成全部 27 组验证，生产构建首页哈希在运行前后保持一致。见 `regression-verification.json`。DOCX 与原生检查另使用 Node 22 验证，未将整套回归描述为 Node 22 结果。

本地详细日志：`test-results/ci-repair-regression.log`、`test-results/ci-repair-docx-node22.log`、`test-results/ci-repair-native-node22-direct.log`；这些临时文件由 `.gitignore` 排除。
