# main 合并后 CI 失败修复（2026-10-15）

失败运行：https://github.com/SoleyRan/EasyM/actions/runs/38709886741

提交 `ef698da` 已包含上一轮全部修复；本次 Windows、macOS、Linux 桌面任务通过，前端在 `verify-docx-ui.mjs` 的大文档导出断言失败。导出 XML 仍是前一份“EasyM 办公导出验收”样例，缺少“大样例”。上一轮 CI 通过并未排除焦点竞争。

## 复现与修复

关闭 DOCX 后，`finishDocx` 仍在下一动画帧无条件把焦点交给 EM 菜单，而弹层已有关闭时的焦点恢复。人工延后这个动画帧，在源码全选后、输入多行正文前释放，可稳定观察到焦点从源码变为 EM 菜单，输入结果只保留第一行。修复前的本地重复 DOCX 验收中也出现过一次断言失败；不能将远端失败误认为只需重跑即可解决。

设置、使用导引、DOCX、PDF 预览、版本历史和批量图片弹层现在统一通过 `useModalOverlay` 在关闭提交的微任务内恢复焦点，移除重复的动画帧/定时器回调。用户已经聚焦其他有效控件时，关闭回调保留新焦点；已有弹层代际、嵌套弹层、隐藏与 inert 检查继续生效。DOCX 警告定位仍保留原有跳转行为。

新增 `verify:focus`：在对话框关闭后暂存动画帧，在全选与输入之间统一释放，覆盖 DOCX 取消/下载、PDF 预览、设置、导引。逐项检查焦点、完整多行正文，以及立即导出的 DOCX 实际 XML 内容。六倍 CPU 降速场景纳入 CI，报告单独保存。DOCX 大样例在导出前增加完整草稿断言，避免输入未完成时仍用旧样例进行性能验收；既有 140000 处正文、100 处图片及草稿一致性断言保留。

未改变共享 `fillSource` 输入方法，没有加入重试或固定等待，也没有移除原有验收。

## 本地验证

- Windows：`pnpm build`（包含类型检查）、50 个测试文件 / 282 项单元测试通过。
- Windows / Node 22 / Chromium 156：焦点验收和 3652113 字节、100 图片引用的 DOCX 验收通过，见对应 JSON。
- Ubuntu 24.04 / WSL / Node 22 / Chromium 156：六倍 CPU 降速焦点验收通过，见 `focus-linux-slow-verification.json`。
- Ubuntu 24.04 / WSL / Node 22：完整 DOCX UI 验收通过，见 `docx-ui-linux-verification.json`。
- Windows / Node 22：28 组完整生产包回归通过，见 `regression-windows-verification.json`；该报告包含构建首页的 SHA-256，整套运行期间构建未变化。
- 随后补充父子弹层的焦点优先级边界：子弹层关闭后，优先回到仍存在的父弹层。4 项弹层定向单元测试与类型检查通过；完整 283 项单元测试以最终提交的云端 CI 为准。

浏览器验收不能替代 Word/WPS 的分页、编辑性和人工 GUI 验收；本轮无 Rust 或原生配置变更。云端结果以修复分支及 PR 的 GitHub Actions 为准。
