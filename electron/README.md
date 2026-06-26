# XControl 桌面版（Electron）

将 XControl（Go 后端 + React 前端）打包成 Windows 桌面应用。

## 架构

```
Electron 主进程 (main.js)
   │  1. 申请空闲端口
   │  2. 以子进程启动 xcontrol-server（embed 了前端静态文件）
   │  3. 轮询后端就绪后加载 http://127.0.0.1:<port>/
   │  4. 退出时结束后端进程
   ▼
BrowserWindow  ──HTTP/WS──>  xcontrol-server  ──SSH──>  远程主机
```

### 跨平台窗口标题栏

| 平台 | 窗口配置 | 控制按钮 |
|------|---------|---------|
| **macOS** | `titleBarStyle: 'hiddenInset'` | 系统原生交通灯（左侧红黄绿），不自绘 |
| **Windows** | `frame: false` | 自绘右侧按钮（最小化/最大化/关闭），关闭悬停红 |
| **Linux** | `frame: false` | 自绘右侧按钮（同 Windows 风格） |

- 前端通过 `window.xcontrol.platform` 判断平台，macOS 不渲染自绘按钮，标题栏左侧留 78px 给交通灯。
- 后端可执行文件名跨平台：Windows 为 `xcontrol-server.exe`，macOS/Linux 为 `xcontrol-server`（无后缀）。`extraResources` 用 `${osExeSuffix}` 宏自动适配。

- 前端构建产物通过 `//go:embed` 打进 `xcontrol-server.exe`，无需单独分发静态文件。
- 数据库（`xcontrol.db`）和密钥（`key`）存放在用户数据目录（`%APPDATA%/XControl`），卸载不删除。
- 后端日志：`%APPDATA%/XControl/logs/backend.log`。

## 关键改动说明

| 文件 | 作用 |
|------|------|
| `server/web_prod.go` | `prod` 构建标签下 `//go:embed all:web_dist` 嵌入前端 |
| `server/web_dev.go` | 默认（dev）模式返回 nil，前端由 Vite dev server 提供 |
| `server/gateway/router.go` | `NewRouter` 增加 `webFS` 参数，非空时注册 SPA 静态路由 |
| `web/vite.config.ts` | `build.outDir` 改为 `../server/web_dist` |
| `electron/main.js` | Electron 主进程，管理后端子进程生命周期 |

## 打包

### 构建脚本（支持三平台）

```bash
# 在任意平台打包当前平台
cd electron && ./build.sh

# 指定目标平台
./build.sh win       # Windows NSIS（Linux/macOS 上需 wine）
./build.sh mac       # macOS DMG（需在 macOS 上执行，支持 arm64）
./build.sh linux     # Linux AppImage + deb
```

Windows 本地（PowerShell）：

```powershell
cd electron
.\build.ps1
```

### 各平台产物

| 平台 | 命令 | 产物 | 说明 |
|------|------|------|------|
| Windows | `./build.sh win` 或 `.\build.ps1` | `XControl-Setup-1.0.0-x64.exe` | NSIS 安装包 |
| macOS | `./build.sh mac` | `XControl-1.0.0-x64.dmg` / `XControl-1.0.0-arm64.dmg` | DMG 镜像（Intel + Apple Silicon） |
| Linux | `./build.sh linux` | `XControl-1.0.0-x64.AppImage` / `.deb` | AppImage 通用 + deb 包 |

### 方式一：在 Windows 上本地打包（推荐 Windows 版）

前置：安装 [Node.js](https://nodejs.org/) 18+ 与 [Go](https://go.dev/dl/) 1.22+。

```powershell
cd electron
.\build.ps1
```

产物：`electron/release/XControl-Setup-1.0.0-x64.exe`（NSIS 安装包）。

### 方式二：在 Linux/macOS 上交叉打包 Windows 版

前置：Node.js、Go。首次打包 Windows NSIS 时需要 wine：

```bash
# Ubuntu/Debian 安装 wine（electron-builder 需要）
dpkg --add-architecture i386
apt-get install -y wine64 wine32
# Ubuntu 24.04 的 wine 不在 PATH，需建立链接
ln -sf /usr/lib/wine/wine /usr/local/bin/wine
ln -sf /usr/lib/wine/wine64 /usr/local/bin/wine64

cd electron && ./build.sh win
```

> 交叉打包偶发 NSIS/wine 问题，若失败建议改用 Windows 机器执行 `build.ps1`。

### 方式三：macOS 本地打包

前置：macOS 机器、Node.js、Go。

```bash
cd electron && ./build.sh mac
```
脚本自动检测 Apple Silicon (arm64) 或 Intel (x64)。

### 方式四：Linux 本地打包

```bash
cd electron && ./build.sh linux
```

## 开发调试

桌面壳开发时，可让 Electron 连接本地已运行的后端，避免反复编译 exe：

1. 启动后端（dev 模式，前端走 Vite）：
   ```bash
   cd server && go run .            # 后端 :9090，但 dev 不 serve 前端
   cd web && npm run dev            # 前端 :5173，代理 /api /ws 到 :9090
   ```
2. 让 Electron 直接加载 Vite：设置环境变量后启动
   ```bash
   # electron/main.js 在开发模式下默认找 ../server/xcontrol-server.exe
   # 若想连已有后端，可改 main.js 临时把 loadURL 指向 http://localhost:5173
   cd electron && npm install && npm start
   ```

## 注意事项

- 后端使用 `modernc.org/sqlite`（纯 Go），交叉编译 **无需 CGO**，`CGO_ENABLED=0` 即可。
- `xcontrol-server.exe` 通过 `extraResources` 打入安装包的 `resources/xcontrol-server/` 目录。
- 若需自定义图标，把 `build/icon.ico` 放入 `electron/` 并在 `package.json` 的 `build.win` 加 `"icon": "build/icon.ico"`。
- 端口动态分配，多开受单实例锁限制（第二次启动会聚焦到已有窗口）。
