# 通过 GitHub Actions 获取 Android APK

本文用于在不安装本地 Android SDK 的情况下，通过 GitHub Actions 生成可直接安装到 Android
手机的 eizhu debug APK。该 APK 仅用于开发和真机验收，不用于 Google Play 或其他商店发布。

## 构建方式

工作流文件为 `.github/workflows/build-android-apk.yml`，支持两种触发方式：

1. 创建或更新 pull request 时自动构建。
2. 工作流进入默认分支后，在 GitHub 的 Actions 页面使用 `Run workflow` 手动构建。

云端 runner 会安装 Android API 36、Build Tools 36.0.0、NDK r29 和 arm64 Rust target，随后
初始化 Tauri Android 工程并执行：

```bash
npm run android:build -- --debug --apk --target aarch64 --ci
```

本地电脑和 Codex 工作区均不需要安装或下载 Android SDK/NDK。

## 首次构建步骤

1. 将 `codex/mobile-adaptation` 分支推送到 GitHub。
2. 在 GitHub 上创建该分支到 `dev` 的 pull request。
3. 打开 pull request 的 `Checks`，等待 `Android Installable APK / Build debug APK` 完成。
4. 也可以进入仓库的 `Actions → Android Installable APK` 查看日志。
5. 在成功运行页面底部下载 `eizhu-android-debug-<commit>` artifact。
6. 解压 artifact，得到 `.apk` 文件。

同一次运行还会提供 `eizhu-android-generated-<commit>`，它是不含构建缓存和本机配置的 Tauri
Android 生成工程，用于审查后回写 `src-tauri/gen/android`。

## 安装到手机

1. 把 APK 发送到 Android 手机，例如通过数据线、网盘或局域网文件传输。
2. 在手机设置中允许当前文件管理器或浏览器“安装未知应用”。
3. 打开 APK 并确认安装。
4. 安装完成后关闭“安装未知应用”授权，减少不必要的安全暴露。

首次启动后至少验证：

- 主机、分组、片段和 Vault 页面可以打开。
- 可以新增测试服务器并建立 SSH 会话。
- 未知主机密钥会要求明确确认。
- 终端键盘、方向键、Ctrl、Alt、粘贴和返回键行为正常。
- SFTP 可以通过系统文件选择器上传和下载测试文件。
- 进入后台后显示远程会话通知，回到前台后状态正确。

完整测试矩阵见 `docs/MOBILE_RELEASE.md`。

## Debug 签名限制

GitHub runner 会为 debug APK 使用临时 debug 签名。不同工作流运行生成的签名可能不同，因此
后续 APK 覆盖安装如果提示“签名不一致”，先卸载旧版再安装新版。卸载会清除应用本地数据，
需要保留数据时应先导出备份。

需要长期覆盖升级时，再创建并妥善备份固定测试/发布密钥，配置现有的
`ANDROID_KEY_BASE64`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` GitHub Secrets，改用固定
签名构建。在仅验证第一个 APK 的阶段不需要配置这些 Secrets，也不需要使用 Google Play 账号。

## 失败排查

构建失败时保留 Actions 运行链接，并重点记录第一个失败步骤：

- `Set up Android SDK and NDK in GitHub runner`：云端 SDK 下载或许可证问题。
- `Initialize generated Android project`：Tauri 配置或插件生成问题。
- `Build installable arm64 debug APK`：Kotlin、Swift 以外的 Android/Rust 编译问题。
- `Upload installable APK`：构建完成但 APK 输出路径不符合预期。

不要只发送最后一行错误；应提供第一个失败步骤从错误前约 30 行到错误后的完整日志，并确认日志
中没有密钥或其他敏感信息。
