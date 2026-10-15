# v0.6 第二轮 CI 修复验证（2026-10-15）

失败运行：https://github.com/SoleyRan/EasyM/actions/runs/38700080852

基于提交 `5855563026d9f566e81a3210e26da69ded4439e9`。该次运行中，macOS、Linux 桌面构建通过，上一轮 DOCX 验收问题也已通过；本轮处理前端公式验收和 Windows 原生扩展验收两处失败。

## 公式与草稿恢复

CI 截图中，失败时源码和预览都只剩第一行 `# 数学公式`，因此不能把等待矩阵超时归因为公式渲染器未显示。恢复草稿后，原脚本关闭设置并重新输入整份样例；应用关闭设置会在下一动画帧恢复菜单焦点，重复输入依赖这一时序。完整的输入截断原因未在本地稳定复现。

修复验收流程：恢复草稿后直接断言其内容等于完整样例，移除重复输入，并等待设置关闭后的菜单焦点恢复。这样同时验证真实恢复结果，避免重新输入掩盖草稿恢复失败。保留原有公式、主题、导出和离线断言，新增六倍 CPU 降速 CI 验收，普通和降速报告分别保存。

本地验证：

- Ubuntu 24.04 / WSL、Node 22.23.3、Chromium 156.0.8078.4：普通与六倍降速均通过。
- Windows、Node 24.20.0、Chromium 156.0.8078.4：六倍降速通过。
- `pnpm typecheck`、`pnpm build` 通过。本轮未修改产品源码、共享测试输入工具或 Rust 代码，没有把定向验收描述为完整回归。

## Windows WebView2 调试连接

CI 产物显示 WebView2 已运行，但实际命令行中缺少调试参数，隔离目录中也没有 `DevToolsActivePort`。微软文档明确说明，提权宿主忽略 `WEBVIEW2_*` 环境变量及 HKCU 覆盖，但接受 HKLM 策略：

https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags

脚本现在检测提权状态；提权时临时设置仅对 `easym.exe` 生效的 HKLM 浏览器参数和隔离数据目录。结束时恢复已有值及其注册表类型，删除本次新建的空叶键，恢复进程环境变量；清理失败也会使验收失败。普通本地进程继续使用环境变量。未修改发行应用的调试配置或 CSP。

本机 Node 22.23.3 / WebView2 155.0.4283.45 普通权限原生验收通过，应用正常关闭、退出码为 0，见 `native-extensions-verification.json`。

另将原脚本的策略分支重定向到独立 HKCU 沙盒，强制启动失败，确认已有策略内容与 ExpandString 类型恢复、其他可执行文件策略不变、新建叶键移除、环境变量恢复，见 `policy-cleanup-verification.json`。这项检查不等价于实际提权 HKLM/WebView2 验收；本机不是提权进程，最终仍须由修复后的 Windows GitHub runner 确认。

临时日志与原始 CI 产物位于被 Git 忽略的 `test-results/ci-38700080852/` 等目录。此处记录本地验证结果，未宣称远端 CI 已通过。

## 推送后的云端验证及 Mermaid 补充

修复提交 `5f2332a` 对应运行：https://github.com/SoleyRan/EasyM/actions/runs/38707285902

该运行的公式验收已通过。其后的 Mermaid 验收在相同的恢复/关闭设置/重新输入流程失败，截图也只剩第一行 `# Mermaid 离线图表`。同步移除 Mermaid 验收中恢复后的重复输入，并检查完整恢复内容与设置关闭焦点。Linux Node 22 定向 Mermaid 验收通过，见 `mermaid-linux-verification.json`。云端原始日志及截图保存在 `test-results/ci-38707285902/`。
