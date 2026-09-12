# GitHub Actions 发版流程

eizhu 采用 `dev` / `main` 双分支晋级模型：`dev` 是测试通道，`main` 是正式通道。
发版只由分支推送触发，不再通过人工创建 tag 触发。

> GitHub Release 底层必须关联 tag。工作流会在发布时自动创建 tag，
> 它是 Release 的不可变标识，不是发版入口，无需人工维护。

## 分支与通道

| 推送分支 | 类型 | 版本号 | GitHub Release |
|----------|------|--------|----------------|
| `dev`（桌面） | 测试版 | `<VERSION>-test.<提交计数>.<短SHA>` | Prerelease（`test-v*`） |
| `main`（桌面） | 正式版 | `<VERSION>` | 正式 Release（`v*`） |
| `dev`（移动端） | 测试版 | `<VERSION_MOBILE>-test.<提交计数>.<短SHA>` | Prerelease（`test-android-v*`） |
| `main`（移动端） | 正式版 | `<VERSION_MOBILE>` | 正式 Release（`v<VERSION_MOBILE>`） |

桌面端与移动端版本分开管理：`VERSION` 是桌面端发版版本源，`VERSION_MOBILE` 是移动端
（Android / iOS）版本源，格式都必须为 `x.y.z`。两个私有 npm 包与
`tauri.conf.json` 不再保存重复版本；本地与 CI 构建都会在运行时把对应版本注入 Tauri
（`scripts/run-tauri.mjs` 按命令选择版本文件，可用 `EIZHU_APP_VERSION` /
`EIZHU_MOBILE_VERSION` 覆盖）。
Cargo manifest 受格式约束必须声明版本，`build.rs` 会读取 `VERSION` 并强制校验两者一致。
正式版已存在时，对应发布工作流会拒绝复用该版本号。

test 版本号由「提交计数 + 短 SHA」组成（如 `0.4.2-test.486.1a2b3c4`）：提交计数用
`git rev-list --count HEAD` 计算（同一提交两条流水线得到相同数值），随提交历史单调
递增，保证 Windows NSIS 与应用内更新始终把新测试包判定为“升级”，避免因旧
`-test.<sha>` 字典序回退导致覆盖安装被强制要求先卸载；短 SHA 提供构建可追溯性，
同一提交重跑时版本不变、资产覆盖到同一个 test Release。

## 推荐发版流程

1. 日常开发通过功能分支 PR 合入 `dev`。
2. `dev` 每次推送自动运行质量门禁，并发布三平台测试版。
3. 进入发布候选阶段时，按 SemVer 提升 `VERSION` 与 `VERSION_MOBILE`，完成回归后由
   `dev` 提 PR 到 `main`。
4. `main` 只通过该发布 PR 更新；合并后自动发布同版本正式版。
5. 发布后将 `main` 同步回 `dev`，并将 `VERSION` / `VERSION_MOBILE` 提升到下一个计划
   版本，使后续测试版在 SemVer 上高于已发布的稳定版。

建议在 GitHub 为 `main` 开启分支保护：禁止直接推送，要求 PR、`Quality` 全部通过
且至少一人审批。`dev` 至少要求 `Quality` 通过。

## 产物

| 平台 | 格式 | 应用内更新 |
|------|------|-----------|
| Windows (x64) | NSIS 安装程序 `.exe` | ✅ |
| macOS (Apple Silicon) | DMG 镜像 + `.app.tar.gz` | ✅ |
| Linux (Debian/Ubuntu) | `.deb` | ❌（手动覆盖安装） |
| Linux (Fedora/RHEL) | `.rpm` | ❌（手动覆盖安装） |
| Linux (通用) | `.AppImage` | ✅ |
| Android (arm64) | debug `.apk`（独立 Android Prerelease） | ❌（手动下载安装，见下方签名说明） |

稳定版与测试版的 updater 清单分别为 `latest-stable-*` 和 `latest-test-*`，
由固定的 `tauri-update-channel` Release 保存最新指针。
Android 测试包使用独立的 `test-android-v<VERSION_MOBILE>-test.<提交计数>` 标签发布，
避免与桌面 Release 及 updater 固定标签冲突。

## Secrets（可选）

| Secret | 说明 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | updater 签名私钥；未配置时仅应用内更新不可用 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（空密码留空） |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` | macOS 签名 |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证 |
| `ANDROID_KEY_BASE64` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | Android 上传密钥；未配置时 APK 使用 runner 随机 debug 签名，无法覆盖安装（配置方法见 `docs/ANDROID_APK_GITHUB.md`） |

Windows 覆盖安装说明：`tauri.conf.json` 已启用 `bundle.windows.allowDowngrades`，
安装器在检测到“降级”（例如从正式版切回测试版）时也允许直接覆盖安装而不强制卸载；
应用数据在卸载时也可选择保留。

## 本地验证

```bash
npm run desktop:build
npm run desktop:smoke
```
