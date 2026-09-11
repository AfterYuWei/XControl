# eizhu 移动端迁移状态

本文记录 `MOBILE_ADAPTATION_PLAN.md` 的实际实施状态。功能是否可用以本表和自动化测试为准，
不以目录或占位接口的存在为准。

## 支持矩阵

| 能力 | Desktop | Android | iOS | 当前状态 |
| --- | --- | --- | --- | --- |
| Profile / Group / Snippet / Audit | ✅ | 编译接入 | 编译接入 | 共享 Rust command 已注册 |
| SSH / SFTP Rust 核心 | ✅ | ✅ | ✅ | 同 ID 恢复、主机密钥确认、交互认证已接入 |
| Vault / SQLite / Backup / Sync | ✅ | ✅ | ✅ | 密文格式不变；Android Keystore / iOS Keychain 保存主密钥 |
| 平台能力发现 | ✅ | ✅ | ✅ | `platform_capabilities`，禁止 UA 推断 |
| 桌面窗口、拖出、updater | ✅ | 不支持 | 不支持 | capability 隔离 |
| OAuth deep link | ✅ | 配置完成 | 配置完成 | 真机回调待验收 |
| 系统文档选择器 | ✅ | ✅（待真机） | ✅（待真机） | SAF / Document Picker 先复制到私有暂存区，领域层仅接收不透明引用 |
| 360 秒后台窗口 | 不适用 | ✅（待真机） | ✅（待真机） | Android 前台服务；iOS 逻辑恢复窗口 |
| Keystore / Keychain | 不适用 | ✅（待真机） | ✅（待真机） | Keystore AES-GCM 包装 / Keychain ThisDeviceOnly；旧密钥验证后迁移 |
| 移动布局和终端工具栏 | 不适用 | ✅ | ✅ | 独立 MobileLayout、底部导航、动态视口与触控工具栏 |

## 平台边界

- `commands/platform.rs` 是前端识别原生能力的唯一事实来源。
- `__TAURI_INTERNALS__` 只用于判断是否存在 Tauri IPC，不能用于判断 desktop/mobile。
- `infrastructure/platform/desktop` 继续由 `#[cfg(desktop)]` 隔离。
- Android `content://` 和 iOS security-scoped URL 统一经过 `DocumentGateway`；原生层复制到应用
  私有暂存区，Rust 校验路径边界并向领域层提供不透明引用或受控字节流。
- DocumentGateway 在上传、下载导出、私钥和备份流程结束后清理暂存文件，并在冷启动时清扫
  异常退出遗留文件。
- 移动 SFTP 默认单栏远端浏览，并发上限为 2；桌面双栏、拖放与并发上限 5 保持不变。
- `MasterKeyStore` 在 Android 使用 Keystore AES-GCM 包装主密钥，在 iOS 使用 Keychain
  `AfterFirstUnlockThisDeviceOnly`；SQLite schema 与 AES-256-GCM 密文表示均不改变。
- 移动旧密钥迁移会先验证 Vault、Profile、同步 Provider 和同步密码的全部已有密文，再写入并
  回读安全存储，最后删除旧文件；任一步失败均保留旧文件。
- 密码和私钥复制后显示 30 秒倒计时，仅当剪贴板仍等于应用写入值时清空，避免覆盖用户随后
  复制的其他内容。
- SSH Agent、窗口拖出、桌面调试日志与传统路径迁移继续由 desktop capability / `cfg(desktop)`
  隔离，移动端既不注册对应命令也不显示入口。
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
| 2 SSH 生命周期 | 代码完成 | 360 秒状态机、真实 SSH 探活、同 ID/退避重连、SSH/SFTP 指纹确认、keyboard-interactive；真机后台行为待发布门禁 |
| 3 移动交互 | 代码完成 | 独立手机/平板布局、Android 返回键、Tauri Channel、16ms/32KiB 批量与 1MiB 重放 |
| 4 DocumentGateway | 代码完成 | Android SAF、iOS Document Picker、私有暂存与路径校验；SFTP/私钥/备份导入导出已接入，真机 Provider/iCloud 测试待发布门禁 |
| 5 安全存储 | 代码完成 | Android Keystore 包装、iOS Keychain、失败回滚迁移测试、敏感剪贴板条件清理与 Desktop-only 隔离；真机安全存储升级测试待发布门禁 |
| 6 发布与可观测性 | 代码完成 | debug APK/release AAB/R8、iOS Simulator/签名 Archive CI；移动诊断页及结构化生命周期字段；真机与商店审核见 `MOBILE_RELEASE.md` |

## 发布门禁

- Android：API 24、主流版本、最新版本真机；后台 30/180/359/361 秒边界。
- iOS：Document Picker、Keychain、系统提前结束后台任务、网络切换和前台恢复。
- 所有平台：未知/变化主机密钥必须明确确认，数据库 schema、密文和备份格式保持兼容。
- 自动化检查通过不替代 Android/iOS 真机门禁。
