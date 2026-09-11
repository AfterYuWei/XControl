# eizhu Tauri 移动端适配与 360 秒后台保活方案

## 总体方案

保留现有 React/TypeScript UI、Rust SSH/SFTP 核心、SQLite 数据模型及加密格式，不增加本地 HTTP/WebSocket 服务。通过 Tauri 2 移动端插件桥接 Android/iOS 原生能力，分阶段完成移动布局、SSH 生命周期、SFTP 文件访问、安全存储和发布体系。

后台策略统一定义为 `BACKGROUND_KEEPALIVE_SECONDS = 360`：

- Android 使用前台服务实现可验收的 360 秒 SSH/SFTP 后台运行窗口。
- iOS 受系统机制限制，无法保证任意 TCP/SSH 连接后台持续 360 秒；实现“最长请求 360 秒 + 系统到期安全挂起 + 回前台自动恢复”的逻辑窗口。
- 360 秒后不继续隐式消耗电量，也不在后台无限重连。

## 核心架构与接口

### 平台分层

```text
React 功能组件、Zustand Store、Tauri API
                │
     DesktopLayout / MobileLayout
                │
 PlatformCapabilities + PlatformGateway
                │
       Tauri Commands / Channels
                │
      Rust SSH/SFTP 共享业务核心
                │
 SessionManager + LifecycleCoordinator
         ┌──────┴──────┐
 Desktop Platform   Mobile Plugin
                    ├─ Android/Kotlin
                    └─ iOS/Swift
```

新增统一能力接口：

- `platform_capabilities()`：返回平台、文件选择器、安全存储、后台模式、生物识别、窗口能力。
- `session_subscribe(session_id)` / `session_unsubscribe(subscription_id)`：使用 Tauri Channel 推送终端数据、状态和认证请求。
- `session_reconnect(session_id)`：由 Rust 复用原会话 ID 重连。
- `session_auth_respond(request_id, response)`：响应 keyboard-interactive 等认证。
- `host_key_decide(request_id, decision)`：支持 `trust_once`、`trust_permanently`、`reject`。
- SFTP 会话使用相同的主机密钥确认和生命周期模型。
- `DocumentGateway`：统一 Android SAF、iOS Document Picker 和桌面路径访问。
- `MasterKeyStore`：桌面密钥文件、Android Keystore、iOS Keychain 的统一抽象。

会话状态统一为：

```text
connecting → connected → reconnecting → disconnected
                           └────────────→ failed
```

错误结构保留现有兼容字段，并增加：

- `code`
- `message`
- `retryable`
- `details`
- `session_id`
- `stage`

## 实施阶段

### 1. 基线审计与移动工程初始化

- 新增 `docs/MOBILE_MIGRATION.md`，记录桌面能力、移动支持矩阵、平台差异和验收状态。
- 初始化 Tauri Android/iOS 工程，React 产物继续作为唯一前端入口。
- Android 最低 API 24，iOS 最低版本 15。
- 使用 Tauri 平台配置拆分移动端窗口、权限、插件和 CSP，不通过前端 UA 判断平台。
- 修复当前 `isTauri` 等检测逻辑将移动 Tauri 误判为桌面的问题；命令是否可调用由 `platform_capabilities` 决定。
- 保留桌面窗口行为和现有命令兼容性，移动端不注册桌面专属命令。
- 将构建拆分为 Web、Rust、Android、iOS 四类 CI 任务。

### 2. SSH 生命周期、安全确认与 360 秒后台策略

#### Rust 生命周期

- 把重连、网络状态、后台状态和超时控制从 React 组件迁入 Rust `LifecycleCoordinator`。
- 重连复用原 `session_id`，避免 UI 标签页、终端缓冲和订阅关系失效。
- 自动重连退避为 `1、2、4、8、16、30` 秒，后续保持 30 秒，单个恢复周期最多 10 次。
- 每次连接必须经过主机密钥校验；未知主机显示确认页，密钥变化必须显式确认，不允许首次连接静默信任。
- 补齐 keyboard-interactive、多步骤认证、密码错误重试和用户取消。
- SSH 与 SFTP 共用主机密钥策略，防止绕过终端侧确认。

#### Android 360 秒后台保活

- 新增 Tauri Android 原生插件和前台服务，在用户主动建立第一个 SSH/SFTP 会话时启动并显示低打扰常驻通知。
- 后台保活默认开启；进入后台时启动 360 秒计时，回到前台后停止计时并重新武装下一次后台窗口。
- 通知显示“eizhu 正在保持 N 个远程会话”，提供“断开全部会话”操作。
- SSH keepalive 默认每 30 秒发送一次；真实终端数据活动同时刷新连接活跃时间，但不延长 360 秒总窗口。
- 仅在 360 秒窗口内允许网络恢复后的自动重连；窗口结束后停止前台服务和后台重连。
- 360 秒到期时：
  - 停止后台定时器和网络重试。
  - 保留会话元数据与终端缓冲。
  - 将连接标记为待前台探测，不伪报仍处于在线状态。
  - 活跃 SFTP 操作返回可重试的 `BACKGROUND_LIMIT`，清理不完整目标文件，保留可安全重试的本地暂存文件。
- 应用回到前台时：
  - 若仍处于 360 秒窗口，先执行最长 5 秒的真实 SSH 探测，成功则继续原连接。
  - 超过 360 秒、网络世代变化或探测失败时，使用原 `session_id` 自动重连。
- Android 清单声明前台服务、网络、通知和唤醒所需权限；SSH 保活采用符合实际用途的 `specialUse` 前台服务类型并声明 `ssh_session_keepalive` 子类型，SFTP 数据传输按适用场景声明 `dataSync`。
- Android 13+ 请求通知权限；用户拒绝后明确提示后台保活能力受限。
- 实现 Android 15 前台服务超时回调和主动 `stopSelf()`，不得依赖系统强制终止。
- 对国产 ROM 的省电限制提供一次性中文引导，但不自动跳转或修改系统设置。
- Google Play 发布前完成前台服务用途声明审核，不用错误的服务类型规避平台规则。[Android 前台服务启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)、[前台服务超时规则](https://developer.android.com/develop/background-work/services/fgs/timeout)。

#### iOS 360 秒逻辑窗口

- 进入后台时调用 UIKit 后台任务 API 并记录 360 秒逻辑截止时间。
- 在系统仍授予后台时间时继续 SSH keepalive；系统 expiration handler 触发后立即停止网络活动、保存状态并结束后台任务。
- 不伪用音频、定位等 Background Mode 延长 SSH 存活。
- 回前台后依据逻辑截止时间、网络变化和 SSH 探测结果恢复原连接。
- UI 文案使用“后台恢复窗口 6 分钟”，不宣称 iOS 能保证 TCP 连接后台运行满 360 秒。
- iOS 验收目标是：系统提前挂起时无崩溃、无数据损坏，并在前台自动恢复，而不是固定 360 秒 socket 在线保证。[Apple 后台执行说明](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)。

### 3. 移动端交互与终端重构

- 保留桌面布局；新增移动端 `MobileLayout`，不在桌面布局上持续堆叠媒体查询。
- 手机底部导航固定为“主机、会话、文件、设置”，Vault 纳入设置。
- 平板使用主从布局：列表与详情并排；手机使用页面级导航。
- 终端页面全屏显示，连接状态和重连状态固定在顶部。
- 增加移动终端工具栏：
  - `Esc`
  - `Tab`
  - `Ctrl`
  - `Alt`
  - 方向键
  - `/`
  - `|`
  - `-`
  - 粘贴
  - 键盘收起
- 使用 `visualViewport`、安全区变量和动态视口高度处理软键盘，不依赖固定 `100vh`。
- 触控目标最小 44×44 CSS 像素；取消对右键、鼠标悬停和滚轮的功能依赖。
- Android 返回键依次处理：关闭弹层、退出搜索、返回上页；终端根页二次确认断开，不直接退出应用。[Tauri Android Back API](https://v2.tauri.app/reference/javascript/api/namespaceapp/#onbackbuttonpress)。
- 终端输出迁移到 Tauri Channel；Rust 侧按约 16ms 或 32KiB 批量推送，单会话保留最多 1MiB 可重放缓冲。
- WebView 重建或页面重新挂载时重新订阅已有会话并恢复缓冲，不创建重复 SSH 会话。[Tauri Channel](https://v2.tauri.app/develop/calling-rust/)。

### 4. 移动 SFTP 与文件交换

- 手机默认单栏远程文件浏览器，平板可显示目录树；不直接照搬桌面双栏拖拽。
- 上传流程：系统文件选择器 → 拷贝到应用私有暂存区 → Rust 分块读取 → SFTP 上传 → 成功或取消后清理。
- 下载流程：远端文件 → 应用私有暂存区 → 校验完成 → 系统保存目标 → 分块写入 URI → 清理暂存。
- Android 完整支持 `content://`，iOS 使用安全作用域 URL；不得假设系统选择结果是真实文件路径。
- 优先使用官方 Tauri Dialog/FS 插件；供应商 Document Provider 不兼容时由 `DocumentGateway` 回退到原生实现。[Dialog 插件](https://v2.tauri.app/plugin/dialog/)、[文件系统 API](https://v2.tauri.app/reference/javascript/fs/)。
- 移动端并发传输默认 2，桌面保持 5。
- 移动端明确提供复制、移动、重命名、删除、跨服务器传输操作，拖放仅作为桌面增强。
- 私钥导入、备份导入导出也统一走 `DocumentGateway`。

### 5. 密钥、存储与平台能力隔离

- SQLite 继续位于 `app_data_dir/eizhu`，保持现有 schema、备份格式和 XControl 导入兼容性。
- 桌面继续使用现有密钥文件。
- Android 使用 Keystore 包装主密钥，iOS 使用 Keychain 保存主密钥；数据库中敏感凭据的加密表示保持兼容。
- 已存在的移动测试数据采用“解密验证成功后写入安全存储，确认成功后再删除旧密钥”的迁移流程。
- resolved credentials 继续在 Rust 中使用零化类型，禁止传入日志、前端 store 和持久化调试信息。
- 剪贴板复制敏感内容后提供倒计时清理；只有剪贴板内容仍等于应用写入值时才清除。
- SSH agent、窗口拖拽导出、桌面日志目录和传统路径迁移标记为 Desktop-only；移动 UI 不展示不可用入口。
- 使用 Tauri 移动插件的 Kotlin/Swift 桥接承载 Keystore、Keychain、网络监听、前台服务和后台任务。[Tauri 移动插件](https://v2.tauri.app/develop/plugins/develop-mobile/)。

### 6. 构建、发布与可观测性

- Android：
  - 生成 debug APK、release AAB。
  - 配置签名、版本号、ABI、ProGuard/R8 和 Play 前台服务声明。
  - CI 至少编译 `aarch64`，发布构建覆盖需要支持的 ABI。
- iOS：
  - 配置 bundle identifier、entitlements、签名和 Archive。
  - CI 完成编译验证；真机网络、后台和文件选择测试作为发布门禁。
- 日志统一包含 `platform`、`session_id`、`lifecycle_state`、`network_generation` 和 `background_elapsed_seconds`，不记录主机密码、私钥和终端输入。
- 调试页展示：
  - 当前网络状态。
  - 前后台状态。
  - 360 秒剩余时间。
  - Android 前台服务状态。
  - iOS 系统授予的剩余后台时间。
  - 最近一次断开/重连原因。

## 测试与验收

### 自动化测试

- 平台检测：Android/iOS 不再进入 Desktop 分支，桌面行为不回归。
- SSH：密码、私钥、keyboard-interactive、代理、跳板机、未知主机、密钥变化。
- 会话恢复：订阅重建、同 ID 重连、重复订阅、网络切换、服务端主动断开。
- 后台状态机：`0、30、180、359、360、361` 秒边界及前后台快速切换。
- 终端：Channel 顺序、批量边界、UTF-8 拆包、1MiB 重放、软键盘 resize。
- SFTP：`content://`、iCloud 文件、空文件、大文件、取消、权限撤销、磁盘空间不足。
- 安全：密钥迁移失败回滚、日志脱敏、剪贴板条件清理、主机密钥拒绝。
- 兼容：旧数据库、旧备份、XControl 备份、现有桌面配置与快捷键。
- 每阶段执行 Web unit/lint/build 与 Rust fmt/check/clippy/test。

### Android 真机验收

- 覆盖 API 24、当前主流版本和最新版本。
- 在标准 Android 系统中，活动 SSH 会话进入后台并锁屏，服务端日志确认同一连接在 360 秒窗口内保持活动。
- 分别在第 30、180、359 秒回前台，确认无需重建会话；第 361 秒回前台时允许探测后重连。
- 验证常驻通知、断开按钮、多会话计数、360 秒后服务停止和 Android 15 超时处理。
- 验证 Wi-Fi/蜂窝切换、断网恢复、Doze、通知权限拒绝、进程被杀及 OEM 强省电模式。
- OEM 强制冻结或用户强制停止不作为“保证在线”场景，但必须在重新打开后正确恢复，不丢配置和终端状态。

### iOS 真机验收

- 记录 `backgroundTimeRemaining`，验证 expiration handler 在系统提前结束任务时安全收尾。
- 分别在短暂后台、系统挂起、网络切换和超过 360 秒后恢复应用。
- 不要求同一 TCP 连接固定存活 360 秒；要求无崩溃、无无限循环、无错误在线状态，并自动恢复原会话。
- 验证 Document Picker、Keychain、前后台切换和进程重启。

### 发布门禁

- 桌面现有功能全部通过。
- Android 360 秒保活真机测试通过。
- iOS 后台安全挂起和前台恢复测试通过。
- 未知/变更主机密钥均有明确确认。
- Google Play 前台服务用途审核材料完成。
- Android 与 iOS 均通过冷启动、升级安装、数据库迁移和备份恢复测试。

## 明确假设与默认决策

- 第一发布优先完成 Android，随后在同一抽象上接入 iOS。
- Android 的 360 秒为标准系统条件下的后台保活验收目标，依赖可见前台服务；用户强制停止和厂商强制冻结不可能由应用绕过。
- iOS 的 360 秒定义为恢复逻辑窗口，不承诺系统允许 SSH socket 实际后台运行满 360 秒。
- 360 秒不会因网络流量、SSH 输出或重连而无限续期；只有用户重新进入前台后才能开启新的窗口。
- 移动端首版包含 SSH、SFTP、主机/分组、片段、Vault、备份导入导出；桌面 SSH agent、窗口拖拽导出等能力不移植。
- 不引入第二套网络后端，不改变 SQLite schema、加密数据表示、备份格式和现有桌面命令契约。
