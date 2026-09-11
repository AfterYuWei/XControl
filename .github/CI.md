# GitHub Actions 发版流程

eizhu 采用 `dev` / `main` 双分支晋级模型：`dev` 是测试通道，`main` 是正式通道。
发版只由分支推送触发，不再通过人工创建 tag 触发。

> GitHub Release 底层必须关联 tag。工作流会在发布时自动创建 tag，
> 它是 Release 的不可变标识，不是发版入口，无需人工维护。

## 分支与通道

| 推送分支 | 类型 | 版本号 | GitHub Release |
|----------|------|--------|----------------|
| `dev` | 测试版 | `<VERSION>-test.<run>.<attempt>` | Prerelease |
| `main` | 正式版 | `<VERSION>` | 正式 Release |

`VERSION` 是唯一的发版版本源，格式必须为 `x.y.z`。两个私有 npm 包与
`tauri.conf.json` 不再保存重复版本；本地与 CI 构建都会在运行时把该版本注入 Tauri。
Cargo manifest 受格式约束必须声明版本，`build.rs` 会读取 `VERSION` 并强制校验两者一致。
正式版已存在时，`main` 发布会拒绝复用该版本号。

## 推荐发版流程

1. 日常开发通过功能分支 PR 合入 `dev`。
2. `dev` 每次推送自动运行质量门禁，并发布三平台测试版。
3. 进入发布候选阶段时，按 SemVer 提升 `VERSION`，完成回归后由 `dev` 提 PR 到 `main`。
4. `main` 只通过该发布 PR 更新；合并后自动发布同版本正式版。
5. 发布后将 `main` 同步回 `dev`，并将 `VERSION` 提升到下一个计划版本，
   使后续测试版在 SemVer 上高于已发布的稳定版。

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
| Android (arm64) | debug `.apk`（独立 Android Prerelease） | ❌（手动下载安装） |

稳定版与测试版的 updater 清单分别为 `latest-stable-*` 和 `latest-test-*`，
由固定的 `tauri-update-channel` Release 保存最新指针。
Android 测试包使用 `android-test-v<VERSION>-test.<run>.<attempt>` 标签，避免与桌面
Release 及 updater 固定标签冲突。

## Secrets（可选）

| Secret | 说明 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | updater 签名私钥；未配置时仅应用内更新不可用 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（空密码留空） |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` | macOS 签名 |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证 |

## 本地验证

```bash
npm run desktop:build
npm run desktop:smoke
```
