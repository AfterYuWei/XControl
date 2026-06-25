#!/usr/bin/env bash
# 跨平台构建 SSHX 桌面应用
# 用法：
#   ./build.sh              # 默认打包当前平台
#   ./build.sh win          # 交叉打包 Windows NSIS（Linux/macOS 上需 wine）
#   ./build.sh mac          # 打包 macOS DMG（需在 macOS 上执行）
#   ./build.sh linux        # 打包 Linux AppImage + deb
# 依赖：Node.js、Go
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="${1:-current}"
case "$TARGET" in
  win)    GOOS=windows GOARCH=amd64; EXT=.exe;       DIST="dist:win";   PLATFORM_DESC="Windows NSIS" ;;
  mac)    GOOS=darwin  GOARCH=amd64; EXT="";         DIST="dist:mac";   PLATFORM_DESC="macOS DMG" ;;
  linux)  GOOS=linux   GOARCH=amd64; EXT="";         DIST="dist:linux"; PLATFORM_DESC="Linux deb+rpm" ;;
  current|"")
    case "$(uname -s)" in
      Darwin)          GOOS=darwin  GOARCH=amd64; EXT="";         DIST="dist:mac";   PLATFORM_DESC="macOS DMG" ;;
      MINGW*|MSYS*|CYGWIN*) GOOS=windows GOARCH=amd64; EXT=.exe;   DIST="dist:win";   PLATFORM_DESC="Windows NSIS" ;;
      Linux*)          GOOS=linux   GOARCH=amd64; EXT="";         DIST="dist:linux"; PLATFORM_DESC="Linux deb+rpm" ;;
      *) echo "未知系统: $(uname -s)"; exit 1 ;;
    esac
    ;;
  *) echo "用法: $0 [win|mac|linux]"; exit 1 ;;
esac

# macOS arm64 (Apple Silicon) 本地构建用 arm64
if [ "$GOOS" = "darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  GOARCH=arm64
fi

echo "==> [1/3] 构建前端 (输出到 server/web_dist)"
cd "$ROOT/web"
npm install
npm run build

echo "==> [2/3] 编译后端 (${GOOS}/${GOARCH}, embed 前端)"
cd "$ROOT/server"
CGO_ENABLED=0 GOOS=$GOOS GOARCH=$GOARCH go build -tags prod -o "sshx-server${EXT}" .

echo "==> [3/3] 打包 Electron 应用 ($PLATFORM_DESC)"
cd "$ROOT/electron"
npm install
npm run "$DIST"

echo ""
echo "✅ 完成。产物位于： $ROOT/electron/release/"
ls -lh "$ROOT/electron/release/" 2>/dev/null || true
