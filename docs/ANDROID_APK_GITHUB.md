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

## 签名与覆盖安装

GitHub runner 会为 debug APK 使用本机随机生成的 debug 签名，不同工作流运行产生的签名
不同，互相覆盖安装会提示“签名不一致”，只能卸载重装（卸载会清除应用本地数据）。

构建流程已内置固定签名支持（`scripts/prepare-android-signing.mjs` 会在
`src-tauri/gen/android/keystore.properties` 存在时把它注入 debug / release 构建），
只要配置了 Android 上传密钥 Secrets，所有 APK（测试包、正式包）都会使用同一把密钥
签名，之后即可直接覆盖升级，测试版与正式版之间也能互相覆盖切换。

### 配置固定签名 Secrets（一次性）

1. 用 `keytool` 生成上传密钥（JDK 自带，Android Studio 内置 JDK 位于
   `<Android Studio>/jbr/bin/keytool`）：

   ```bash
   keytool -genkeypair -v -keystore eizhu-upload.jks \
     -alias eizhu -keyalg RSA -keysize 2048 -validity 10000
   ```

   按提示设置并牢记 keystore 密码与 key 密码（两者可设为相同）。**务必备份该
   `.jks` 文件和密码**——密钥丢失后已发布的 APK 将永远无法覆盖升级。

2. 计算密钥文件的 Base64：

   ```bash
   base64 -w0 eizhu-upload.jks   # macOS: base64 -i eizhu-upload.jks
   ```

3. 在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加三个 Secret：

   | Secret | 值 |
   |--------|-----|
   | `ANDROID_KEY_BASE64` | 上一步输出的 Base64（一整行，无换行） |
   | `ANDROID_KEY_ALIAS` | `eizhu`（与 keytool `-alias` 一致） |
   | `ANDROID_KEY_PASSWORD` | keystore / key 密码 |

4. 推送到 `dev` 触发一次构建。从这次构建开始，下载的 APK 均为固定签名。

> 注意：切换到固定签名后的第一个 APK 与之前随机签名的旧 APK 签名不一致，
> 仍需最后一次卸载重装；此后即可一直覆盖升级。`main` 分支的发布门禁会强制
> 要求这三个 Secrets 已配置。

## 失败排查

构建失败时保留 Actions 运行链接，并重点记录第一个失败步骤：

- `Set up Android SDK and NDK in GitHub runner`：云端 SDK 下载或许可证问题。
- `Initialize generated Android project`：Tauri 配置或插件生成问题。
- `Build installable arm64 debug APK`：Kotlin、Swift 以外的 Android/Rust 编译问题。
- `Upload installable APK`：构建完成但 APK 输出路径不符合预期。

不要只发送最后一行错误；应提供第一个失败步骤从错误前约 30 行到错误后的完整日志，并确认日志
中没有密钥或其他敏感信息。
