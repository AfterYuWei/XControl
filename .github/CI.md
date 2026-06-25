# GitHub Actions 自动构建

三端安装包自动打包，tag 发正式版，main 分支用 short commit 发 carry 版。

仓库地址：https://github.com/AfterYuWei/XControl

## 触发方式

| 触发 | 类型 | 版本号 | Release 标记 |
|------|------|--------|-------------|
| 推送 `v*` tag | 正式版 | tag 名去 v（如 `1.0.0`） | 正式发布 |
| 推送 `main` 分支 | carry 版 | short commit（如 `73a8ffc`） | 预发布 (prerelease) |
| 手动触发 | 可选 | 同上 | 同上 |

两种模式都会创建 GitHub Release 并上传三端安装包，区别在于 carry 版标记为 prerelease。

## 正式发布

```bash
# 1. 确保版本号已更新（electron/package.json 的 version）
# 2. 打 tag 并推送
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 自动构建三端安装包并创建正式 Release，包含：

| 平台 | 产物 | 说明 |
|------|------|------|
| Windows | `SSHX-Setup-1.0.0-x64.exe` | NSIS 安装程序 |
| macOS (Apple Silicon) | `SSHX-1.0.0-arm64.dmg` | DMG 镜像 |
| macOS (Intel) | `SSHX-1.0.0-x64.dmg` | DMG 镜像 |
| Linux (Debian/Ubuntu) | `SSHX-1.0.0-amd64.deb` | deb 安装包 |
| Linux (Fedora/RHEL) | `SSHX-1.0.0-x64.rpm` | rpm 安装包 |

## Carry 版

每次推送 `main` 分支自动触发，版本号用当前 commit 的 short commit（如 `73a8ffc`），作为 tag 名创建 prerelease Release。适合日常开发验证，用户可随时下载最新构建。

```bash
git push origin main
# CI 用 73a8ffc 作为版本号，创建 prerelease Release
```

## 架构说明

```
prepare (ubuntu)  →  判断 release/carry + 计算版本号与 tag
      ↓
build (matrix 并行)
  ├─ win         (windows-latest)  → SSHX-Setup-x64.exe
  ├─ mac-arm64   (macos-latest)    → SSHX-arm64.dmg
  ├─ mac-x64     (macos-13)        → SSHX-x64.dmg
  └─ linux       (ubuntu-latest)   → SSHX-x64.deb + SSHX-x64.rpm
      ↓
release (ubuntu)    →  创建 GitHub Release（正式版/预发布）
```

### 版本号规则

- **正式版**：`git tag v1.2.3` → 版本号 `1.2.3`，Release tag 为 `v1.2.3`
- **carry 版**：main 分支 commit `73a8ffc...` → 版本号 `73a8ffc`，Release tag 为 `73a8ffc`

### macOS 双架构

macOS 拆成两个 job 并行构建：
- `macos-latest`（Apple Silicon runner）→ arm64 dmg
- `macos-13`（Intel runner）→ x64 dmg

每个 job 只编译对应架构的 Go 后端，CI 动态修改 `package.json` 的 `mac.target.arch`，确保后端二进制与 dmg 架构一致。

### 为什么不用 AppImage

按需求只打包安装包（NSIS/DMG/deb/rpm），不打包便携版（AppImage 免安装、win-unpacked 目录）。

## macOS 签名公证（可选）

不配置 secrets 时 electron-builder 自动跳过签名，产物仍可用但分发时 macOS 会提示"无法验证开发者"。配置后自动签名公证：

| Secret | 说明 |
|--------|------|
| `MAC_CERT_BASE64` | 开发者证书 `.p12` 的 base64 编码（`base64 -i cert.p12`） |
| `MAC_CERT_PASSWORD` | 证书导出密码 |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 应用专用密码（appleid.apple.com 生成） |
| `APPLE_TEAM_ID` | 开发者团队 ID |

## 本地验证

```bash
cd electron
./build.sh win       # Windows（Linux 上需 wine）
./build.sh mac       # macOS（需 macOS 机器）
./build.sh linux     # Linux deb+rpm
```
