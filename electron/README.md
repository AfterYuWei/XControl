# SSHX 桌面版（Electron）

将 SSHX（Go 后端 + React 前端）打包成 Windows 桌面应用。

## 架构

```
Electron 主进程 (main.js)
   │  1. 申请空闲端口
   │  2. 以子进程启动 sshx-server.exe（embed 了前端静态文件）
   │  3. 轮询后端就绪后加载 http://127.0.0.1:<port>/
   │  4. 退出时 taskkill 结束后端进程树
   ▼
BrowserWindow  ──HTTP/WS──>  sshx-server.exe  ──SSH──>  远程主机
```

- 前端构建产物通过 `//go:embed` 打进 `sshx-server.exe`，无需单独分发静态文件。
- 数据库（`sshx.db`）和密钥（`key`）存放在用户数据目录（`%APPDATA%/SSHX`），卸载不删除。
- 后端日志：`%APPDATA%/SSHX/logs/backend.log`。

## 关键改动说明

| 文件 | 作用 |
|------|------|
| `server/web_prod.go` | `prod` 构建标签下 `//go:embed all:web_dist` 嵌入前端 |
| `server/web_dev.go` | 默认（dev）模式返回 nil，前端由 Vite dev server 提供 |
| `server/gateway/router.go` | `NewRouter` 增加 `webFS` 参数，非空时注册 SPA 静态路由 |
| `web/vite.config.ts` | `build.outDir` 改为 `../server/web_dist` |
| `electron/main.js` | Electron 主进程，管理后端子进程生命周期 |

## 打包

### 方式一：在 Windows 上本地打包（推荐，最稳妥）

前置：安装 [Node.js](https://nodejs.org/) 18+ 与 [Go](https://go.dev/dl/) 1.22+。

```powershell
cd electron
.\build.ps1
```

产物：`electron/release/SSHX-Setup-1.0.0-x64.exe`（NSIS 安装包）。

### 方式二：在 Linux/macOS 上交叉打包 Windows 版

前置：Node.js、Go。首次打包 Windows NSIS 时 electron-builder 会自动下载 wine 相关依赖。

```bash
cd electron
chmod +x build.sh
./build.sh
```

> 交叉打包偶发 NSIS/wine 问题，若失败建议改用 Windows 机器执行 `build.ps1`。

### 仅生成免安装目录（调试用）

```bash
cd electron
npm install
npm run dist:dir      # 产物在 electron/release/win-unpacked/
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
   # electron/main.js 在开发模式下默认找 ../server/sshx-server.exe
   # 若想连已有后端，可改 main.js 临时把 loadURL 指向 http://localhost:5173
   cd electron && npm install && npm start
   ```

## 注意事项

- 后端使用 `modernc.org/sqlite`（纯 Go），交叉编译 **无需 CGO**，`CGO_ENABLED=0` 即可。
- `sshx-server.exe` 通过 `extraResources` 打入安装包的 `resources/sshx-server/` 目录。
- 若需自定义图标，把 `build/icon.ico` 放入 `electron/` 并在 `package.json` 的 `build.win` 加 `"icon": "build/icon.ico"`。
- 端口动态分配，多开受单实例锁限制（第二次启动会聚焦到已有窗口）。
