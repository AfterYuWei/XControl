# eizhu 移动端构建、发布与真机门禁

本文定义移动端发布产物、签名变量、诊断字段和必须在真实设备完成的发布门禁。CI 编译通过不
代表后台、文件 Provider 或安全存储的真机验收通过。

## 构建产物

`.github/workflows/build-mobile.yml` 在 pull request、`dev` 和 `main` 上运行：

| 平台 | 无签名门禁 | 有签名发布产物 | 当前 ABI / 目标 |
| --- | --- | --- | --- |
| Android | debug APK、release AAB、R8 mapping | upload key 签名的 release AAB | `arm64-v8a` / API 24+ |
| iOS | arm64 Simulator `.app` | App Store Connect Archive / IPA | arm64 / iOS 15+ |

Android 首版正式支持 arm64。需要增加 ABI 时，先在真机矩阵验证，再把 `android build` 的
`--target` 扩展为 `armv7`、`i686` 或 `x86_64`；不得只增加产物而跳过对应设备验收。

版本名称来自根目录 `VERSION` 与 `src-tauri/Cargo.toml`。Android `versionCode` 由 Tauri 按
SemVer 派生，iOS `CFBundleVersion` 默认跟随应用版本；正式发布前必须确认商店中的构建号尚未
使用。

## CI 签名变量

### Android

- `ANDROID_KEY_BASE64`：上传密钥 JKS 的 Base64。
- `ANDROID_KEY_ALIAS`：上传密钥 alias。
- `ANDROID_KEY_PASSWORD`：keystore/key 密码。

CI 仅在非 pull request 构建中解码密钥，并生成不入库的
`src-tauri/gen/android/keystore.properties`。发布 AAB 必须启用 R8，工作流会检查
`mapping/release/mapping.txt` 并与 AAB 一起保存。

### iOS

- `APPLE_API_KEY_BASE64`：App Store Connect `.p8` 私钥的 Base64。
- `APPLE_API_KEY`：Key ID。
- `APPLE_API_ISSUER`：Issuer ID。

CI 将私钥写入 runner 临时目录并设置 `APPLE_API_KEY_PATH`。签名变量齐全时执行
`ios build --export-method app-store-connect`，生成 Archive/IPA；pull request 只构建模拟器版本。

## 商店声明

Android 发布前必须在 Play Console 声明以下真实用途：

- `specialUse`：用户主动建立 SSH/SFTP 会话后，在可见通知下提供最长 360 秒后台恢复窗口；
  subtype 为 `ssh_session_keepalive`。
- `dataSync`：用户主动发起的 SFTP 上传/下载。
- 通知必须显示活动远程会话数量并提供“断开全部会话”，360 秒到期主动停止服务。

不得声明音频、定位等无关用途。iOS 不启用虚假 Background Mode，只使用 UIKit 后台任务并在
系统 expiration handler 中安全挂起。

## 诊断数据

移动端“设置 → 诊断”每秒刷新以下非敏感字段：

- `platform`
- `lifecycle_state`
- `network_generation` 与当前在线状态
- `background_elapsed_seconds` 与 360 秒剩余时间
- Android 前台服务及通知权限
- iOS `backgroundTimeRemaining`
- 最近一次断开/重连原因

生命周期结构化日志使用同名字段，并保留空的 `session_id` 以兼容后续会话级聚合。日志严禁写入
密码、私钥、Passphrase、同步密钥和终端输入。

## Android 真机门禁

- API 24、当前主流版本、最新版本各至少一台真机。
- 第 30、180、359 秒回前台确认复用原连接；第 361 秒确认同会话 ID 探测或重连。
- 验证锁屏、Wi-Fi/蜂窝切换、断网恢复、Doze、通知拒绝、进程被杀、Android 15 服务超时。
- 验证常驻通知、会话数量、“断开全部”、360 秒主动停止和 OEM 强省电中文提示。
- 验证 SAF 的 `content://`、空文件、大文件、取消、权限撤销、磁盘不足和跨服务器传输。
- 验证冷启动、覆盖升级、旧 key 文件迁移、数据库与 XControl 备份恢复。

## iOS 真机门禁

- 验证短暂后台、系统提前 expiration、网络切换、超过 360 秒及进程重启后的同 ID 恢复。
- 记录系统实际 `backgroundTimeRemaining`；不把逻辑 360 秒窗口表述为 TCP 在线保证。
- 验证 iCloud / Document Picker、安全作用域文件、取消、权限撤销和大文件。
- 验证 Keychain 首装、升级迁移、设备锁定/解锁、冷启动与备份恢复。
- 完成签名 Archive 安装与 App Store Connect 验证。

## 发布签字

发布负责人应在对应版本的测试记录中附上设备型号、OS 版本、30/180/359/361 秒结果、文件
Provider、密钥迁移和备份恢复证据。任一必测项缺失时不得把该版本标记为移动端正式发布。
