# eizhu 移动端迁移状态

本文记录 `MOBILE_ADAPTATION_PLAN.md` 的实际实施状态。功能是否可用以本表和自动化测试为准，
不以目录或占位接口的存在为准。

## 支持矩阵

| 能力 | Desktop | Android | iOS | 当前状态 |
| --- | --- | --- | --- | --- |
| Profile / Group / Snippet / Audit | ✅ | 编译接入 | 编译接入 | 共享 Rust command 已注册 |
| SSH / SFTP Rust 核心 | ✅ | 编译接入 | 编译接入 | 生命周期适配待阶段 2 |
| Vault / SQLite / Backup / Sync | ✅ | 编译接入 | 编译接入 | 安全存储待阶段 5 |
| 平台能力发现 | ✅ | ✅ | ✅ | `platform_capabilities`，禁止 UA 推断 |
| 桌面窗口、拖出、updater | ✅ | 不支持 | 不支持 | capability 隔离 |
| OAuth deep link | ✅ | 配置完成 | 配置完成 | 真机回调待验收 |
| 系统文档选择器 | ✅ | 待阶段 4 | 待阶段 4 | 不把 URI 当作 `PathBuf` |
| 360 秒后台窗口 | 不适用 | 待阶段 2 | 待阶段 2 | iOS 仅定义为逻辑恢复窗口 |
| Keystore / Keychain | 不适用 | 待阶段 5 | 待阶段 5 | 密文格式保持不变 |
| 移动布局和终端工具栏 | 不适用 | 待阶段 3 | 待阶段 3 | DesktopLayout 保持兼容 |

## 平台边界

- `commands/platform.rs` 是前端识别原生能力的唯一事实来源。
- `__TAURI_INTERNALS__` 只用于判断是否存在 Tauri IPC，不能用于判断 desktop/mobile。
- `infrastructure/platform/desktop` 继续由 `#[cfg(desktop)]` 隔离。
- Android `content://` 和 iOS security-scoped URL 必须经过后续 `DocumentGateway`，领域层只接收
  字节流或应用沙箱内受控路径。
- Android/iOS 通过平台配置覆盖移动窗口、安全策略和最低系统版本。

## 本地工具链状态

仓库可在任意桌面开发机运行 Web/Rust 质量检查。Android 工程生成和构建需要 Android SDK、
NDK、JDK 以及四个 Android Rust targets；iOS 工程生成和构建必须在安装完整 Xcode 与
CocoaPods 的 macOS 上执行。

```bash
npm run android:init
npm run android:dev
npm run android:build -- --aab --target aarch64

npm run ios:init
npm run ios:dev
npm run ios:build
```

移动工程属于 Tauri CLI 生成物。首次初始化后提交 `src-tauri/gen/android` 和
`src-tauri/gen/apple`；升级 Tauri CLI 后只有在生成模板发生变化时才重新生成并审查差异。

## 阶段验收记录

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| 1 基线与工程初始化 | 代码完成 | Web/Rust 测试、移动构建 CI；生成工程由具备 SDK 的环境生成并构建 |
| 2 SSH 生命周期 | 未开始 | — |
| 3 移动交互 | 未开始 | — |
| 4 DocumentGateway | 未开始 | — |
| 5 安全存储 | 未开始 | — |
| 6 发布与可观测性 | 未开始 | — |

## 发布门禁

- Android：API 24、主流版本、最新版本真机；后台 30/180/359/361 秒边界。
- iOS：Document Picker、Keychain、系统提前结束后台任务、网络切换和前台恢复。
- 所有平台：未知/变化主机密钥必须明确确认，数据库 schema、密文和备份格式保持兼容。
- 自动化检查通过不替代 Android/iOS 真机门禁。
