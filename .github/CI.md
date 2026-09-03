# GitHub Actions 自动构建（Tauri 分支）

tauri 分支的桌面安装包自动打包（Tauri 2）。tag 发正式版，tauri 分支推送发 carry 版（prerelease）。
main 分支仍运行旧的 Electron 构建管线，两分支 CI 完全独立（per-ref 工作流机制，
见 docs/TAURI_MIGRATION.md §15）。

仓库地址：https://github.com/AfterYuWei/XControl

## 触发方式

| 触发 | 类型 | 版本号 | Release 标记 |
|------|------|--------|-------------|
| 推送 `tauri-v*` tag（tauri 分支提交上） | 正式版 | tag 去 `tauri-v` 前缀 | 正式发布 |
| 推送 `tauri` 分支 | carry 版 | `0.0.0-pre.<日期>.<短commit>` | 预发布 (prerelease) |
| 手动触发 | 可选 | 同上 | 同上 |

## 产物

| 平台 | 格式 | 应用内更新 |
|------|------|-----------|
| Windows (x64) | NSIS 安装程序 `.exe` | ✅ |
| macOS (Apple Silicon) | DMG 镜像 + `.app.tar.gz`（更新资产） | ✅ |
| Linux (Debian/Ubuntu) | `.deb` | ❌（手动覆盖安装） |
| Linux (Fedora/RHEL) | `.rpm` | ❌（手动覆盖安装） |
| Linux (通用) | `.AppImage` | ✅ |

应用内更新：设置 → 关于 → 检查更新（stable 通道，`latest.json` 只随正式版 Release 发布；
carry 版在正式版发布时自动收到升级）。

## 正式发布

```bash
# 1. tauri 分支代码就绪后打 tag 并推送
git tag tauri-v1.1.0
git push origin tauri-v1.1.0
```

合并回 main 后改用常规 `v*` tag（工作流触发条件已同时包含两套前缀，无需修改文件）。

## Secrets（可选）

| Secret | 说明 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | updater 签名私钥（`npx tauri signer generate` 生成的文件内容）。未配置时 CI 跳过签名，安装包正常出包，仅应用内更新不可用 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（空密码留空即可） |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` | macOS 签名（.p12 base64）。未配置自动跳过 |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证 |

## 本地验证

```bash
npm run desktop:build    # 当前平台打包（产物在 src-tauri/target/release/bundle/）
npm run desktop:smoke    # 烟测：XCONTROL_TAURI_SMOKE_OK
```
