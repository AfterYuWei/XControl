# 在 Windows 上本地编译并打包桌面应用
# 依赖：Node.js、Go
# 用法：.\build.ps1           # 默认 Windows
$ErrorActionPreference = "Stop"

$root = Resolve-Path "$PSScriptRoot/.."

Write-Host "==> [1/3] 构建前端 (输出到 server/web_dist)" -ForegroundColor Cyan
Push-Location "$root/web"
npm install
npm run build
Pop-Location

Write-Host "==> [2/3] 编译后端 (windows/amd64, embed 前端)" -ForegroundColor Cyan
Push-Location "$root/server"
$env:CGO_ENABLED = "0"
go build -tags prod -o xcontrol-server.exe .
Pop-Location

Write-Host "==> [3/3] 打包 Electron 应用 (NSIS)" -ForegroundColor Cyan
Push-Location "$root/electron"
npm install
npm run dist:win
Pop-Location

Write-Host ""
Write-Host "==> 完成。安装包位于： $root\electron\release\" -ForegroundColor Green
Get-ChildItem "$root\electron\release" | Format-Table Name, Length
