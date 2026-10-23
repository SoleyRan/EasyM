# EasyM v2.0 第 3 步：验收与交付

分支：`feature/v2.0-step-3-sync`，从 main `0cfb2b5`（第 2 步合并）创建。分三次提交：3A 原生 Provider 与凭据、3B 快照与远端应用、3C 同步界面与端到端往返。本记录随各子阶段更新。

## 3A：原生 WebDAV Provider、凭据与本地缓存（2026-10-23）

### 依赖决定

维护者选定：

- HTTP：`reqwest =0.13.5`，只开 `rustls` 与 `http2`。证书用平台校验器验证，不使用 native-tls，也不启用 cookies 和压缩。
- 凭据：`keyring =3.6.3`，各平台使用原生后端：Windows 凭据管理器、macOS 钥匙串、Linux Secret Service（纯 Rust 加密）。

本机目标 `x86_64-pc-windows-msvc` 的依赖从 563 个增至 619 个。新增 56 个包，均为 MIT、Apache-2.0、ISC、BSD-3-Clause 或其组合许可，无移除。`generate-notices` 在严格模式下许可文本齐全，`verify-notices` 通过。macOS 和 Linux 的许可清单由 CI 在各自平台生成。

### 交付内容

- [原生模块](../src-tauri/src/sync_native.rs)：
  - 绑定：保存在应用数据目录 `sync/bindings-v1.json`，记录 bindingId、本地工作区路径、workspaceId（取自第 2 步的同步身份）、deviceId、服务器地址和用户名。每个工作区目录只能绑定一次。WebView2 测试配置下与最近记录一样隔离。
  - 密码：每个绑定在系统凭据存储中存一项，不写入任何文件。凭据存储不可用时直接报错，不退回到文件存储。返回给界面的绑定信息里没有密码，也没有本地路径。
  - 地址：只接受 HTTPS；只有 `localhost`、`127.0.0.1`、`::1` 允许明文 HTTP，用于本机测试。地址里不能带用户名、密码、查询参数或片段。
  - 请求：
    - 禁用自动重定向，遇到重定向报 `endpoint_redirected`，避免凭据被带到其他站点。
    - 每个请求的地址都必须落在 `easym-sync/v1/<workspaceId>/` 之下。
    - 响应大小有上限：设备头 4 KiB，对象 32 MiB，目录列表 1 MiB。
  - 协议：
    - 设备列表：PROPFIND Depth 1，按本地名解析 `href`（兼容 `d:`、`D:` 和无前缀写法）并做百分号解码。如果出现未知条目、href 不在本目录下，或设备超过 64 台，就报错，不会悄悄返回更短的列表。
    - 写设备头：本机只能写自己 deviceId 的头。三种写法：首次创建（If-None-Match）、按已知版本写（If-Match）、单写者直接写（第 1 步规则）。超时或连接中断时结果记为 unknown，由核心回读本设备头来判定。
    - 对象：上传只新建、不覆盖，同摘要重复上传时校验远端已有内容。Nextcloud 返回 423 时退避重试。
  - 本地对象缓存：放在 `sync/<bindingId>/objects/`，只存经过摘要校验的不可变对象。读缓存时会再校验一次，损坏的条目直接丢弃并重新下载。
  - 同步状态：`sync/<bindingId>/state.json` 由核心写入，写入时校验其中的 workspaceId 和 deviceId 与绑定一致。
  - 退出同步：删除绑定、凭据、同步状态和缓存，不碰工作区和远端数据。
- [前端适配](../src/platform/sync-native.ts)：`NativeSyncProvider` 实现核心的 `SyncProvider`。设备头字节仍由 `src/core` 解析；对象读取后再按摘要校验一次。拒绝访问其他工作区命名空间、写其他设备的头、已取消的调用，这三种情况在发起 IPC 之前就拒绝。错误码配有中文说明。

### 验证

| 检查 | 结果 |
| --- | --- |
| `corepack.cmd pnpm typecheck` | 通过 |
| `corepack.cmd pnpm test` | 63 个文件、384 项通过（新增适配层 5 项） |
| `cargo test --locked` | 115 项通过、1 项按设计忽略（新增 6 项：地址规则、请求不越界、多状态解析、状态映射、密码不落文件且退出同步清理干净、缓存只返回已校验字节）。单测用进程内凭据表，不触碰开发者真实的凭据存储 |
| `cargo test --locked -- --ignored native_dav_round_trip`（第 1 步容器：Apache 2.4.69、Nextcloud 31.0.14） | 两个服务均通过：错误密码报 `unauthorized`；命名空间重复创建幂等；能列出工作区；对象新建、重复上传判为 exists、读取与缺失；设备头首次创建、重复创建判为冲突、列表、读取、单写者写入 |
| 依赖许可（严格模式） | 619 个依赖、347 份许可文件校验通过，缺失 0 |

未验证：系统凭据存储的实机读写（单测使用替身）、TLS 证书错误的实际表现、macOS/Linux 构建与许可清单。这些在 3C 的桌面实机验证和 CI 中覆盖。
