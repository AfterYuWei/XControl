#!/usr/bin/env bash
# 在 Linux/macOS 上交叉编译并打包 Windows 桌面应用
# 依赖：Node.js、Go、（打包 Windows NSIS 需要 wine，electron-builder 会自动调用）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> [1/3] 构建前端 (输出到 server/web_dist)"
cd "$ROOT/web"
npm install
npm run build

echo "==> [2/3] 交叉编译后端 (windows/amd64, embed 前端)"
cd "$ROOT/server"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -tags prod -o sshx-server.exe .

echo "==> [3/3] 打包 Electron 应用 (NSIS)"
cd "$ROOT/electron"
npm install
npm run dist

echo ""
echo "✅ 完成。安装包位于： $ROOT/electron/release/"
ls -lh "$ROOT/electron/release/" 2>/dev/null || true
