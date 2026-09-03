# XControl 桌面端 Electron → Tauri 2 迁移设计方案

> 状态：已评审（2026-09-03），作为实施依据；**P0（脚手架+CI）与 P1（通信桥）已实施并通过端到端验证**（tauri 分支）
> 范围：桌面打包层从 Electron 切换到 Tauri 2；`web/` 与 `server/` 业务逻辑不变
> 关联文档：`docs/DESKTOP_RUNTIME.md`（迁移完成后重写为 Tauri 版）、`docs/DEVELOPMENT.md`

### 实施期关键发现（补充）

1. **dev/prod 由 `custom-protocol` feature 决定，而非 release profile**：tauri crate 的 build.rs 以 `custom-protocol` feature 是否启用判定 `dev` cfg（`dev = !custom_protocol`）。`tauri build` 会自动启用该 feature；**纯 `cargo build --release` 不会**，产出的二进制仍会加载 devUrl（已实测踩坑）。因此 `src-tauri/Cargo.toml` 必须声明 `[features] custom-protocol = ["tauri/custom-protocol"]`（标准模板的 DO NOT REMOVE 项），本地模拟生产行为需 `cargo build --release --features custom-protocol`。
2. **`PR_SET_PDEATHSIG` 按「父线程」触发**：为杜绝孤儿 sidecar（父进程被 SIGKILL 时 Rust 侧清理逻辑不会执行），unix 下 spawn 时设置 `PR_SET_PDEATHSIG=SIGTERM`；但其语义是父**线程**死亡即触发，因此 **spawn 必须在主线程（Tauri 事件循环）执行**，健康轮询留在工作线程（`backend.rs` 的 `spawn_backend`/`orchestrate` 拆分即为此）。已实测：SIGKILL 父进程 → 内核对 sidecar 发 SIGTERM → Go 完整优雅退出（含退出备份）。

## 0. 已确认决策

| 决策点 | 结论 |
|---|---|
| macOS 架构 | 仅 arm64 DMG（CI 单 runner，放弃 Intel Mac） |
| 通信架构 | **方案 A**：Tauri 资产模式 + Go sidecar 纯 API + Bearer（REST）/ `?access_token=`（WS） |
| SFTP 拖拽 | **策略 A**：`dragDropEnabled=true`，外部拖入走 Tauri 事件取 OS 路径，内部拖拽改 pointer 自实现 |
| 自动更新 | 接入 `tauri-plugin-updater`（stable 通道） |
| Linux 产物 | deb + rpm + AppImage |
| 数据目录 | 复用 Electron 时代用户数据目录（无感迁移） |
| 设置存储 | 仅主题/布局/字体等纯 UI 偏好走 localStorage；服务器配置、SSH/SFTP 数据、密钥、凭据仍由 Go 后端 SQLite 持久化，不进 localStorage（与现状一致） |

## 1. 调研关键结论（方案依据）

1. **后端改动极小**：`coder/websocket` 的 `OriginPatterns` 对含 `://` 的 pattern 按 `scheme://host` 匹配（已核实 v1.8.15 源码），`tauri://localhost` 这类 origin 直接放入现有 `XCONTROL_ALLOWED_ORIGINS` 即可，**WS origin 校验零改动**；CORS 中间件已允许 `Authorization` 头，且 OPTIONS 预检在 `AccessToken` 之前短路。唯一必须的后端改动：`AccessToken` 中间件支持 `?access_token=` 查询参数（浏览器 WebSocket 无法携带自定义 Header）。
2. **`Logger` 只记录 `r.URL.Path` 不含 query**，token 不会泄漏进 `backend.log`。
3. **HTML5 DnD 依赖点比 SFTP 更广**：除 SFTP 的 5 类拖放表面（列表背景/文件夹行/树节点/面包屑/标签条）外，**Sidebar"拖服务器进分组"也依赖 HTML5 DnD**（`text/profile-id`）。`dragDropEnabled=true` 在 Windows 上会接管 WebView2 拖放处理器导致这些全部失效——pointer 重构必须覆盖两处。
4. **拖出功能在 Electron 侧是"休眠"的**：`file-drag:start` IPC、`materializeRemoteDrag`、`webContents.startDrag` 在主进程/preload 已完整实现，但前端**从未调用过 `fileDrag.start`**。Tauri 版照常实现该能力并真正接线，无回归风险。
5. **下载保存有 3 处 blob + `<a download>`**（备份导出、SFTP 下载、私钥导出），另有 4 处绕过 `client.ts` 的裸 `fetch`（需统一走带鉴权封装）。WKWebView/WebKitGTK 下 blob 锚点下载不可靠，需 Rust 侧保存兜底。
6. **外链打开在 Electron 中实际已走系统浏览器**（`setWindowOpenHandler` deny + `shell.openExternal`，包括 OAuth 弹窗），Tauri 用 opener 插件 1:1 复刻。
7. **图标素材合格**：`electron/icon.png` 为 1600×1600 RGBA，直接满足 `tauri icon` 源图要求。
8. **Tauri 2 关键能力已核实**：
   - `titleBarStyle: "Overlay"` + `hiddenTitle` + `trafficLightPosition`（macOS，等价 Electron `hiddenInset`）；
   - `dragDropEnabled` 默认 true，Windows 上与 HTML5 DnD 互斥（官方文档明示）；
   - 官方插件 30 个中无 drag-out，使用社区 `tauri-plugin-drag`（crabnebula 维护，Rust crate `tauri-plugin-drag` + npm `@crabnebula/tauri-plugin-drag`，权限 `drag:default`，三桌面平台支持）；
   - externalBin 需 target-triple 后缀命名（如 `xcontrol-server-x86_64-pc-windows-msvc.exe`），打包后保留 triple 后缀存放于资源目录。
9. **Go sidecar 必须继续用 `-tags prod` 构建**：非 prod 构建里 `SetDevDefaults` 会无条件把日志级别覆盖成 debug（无视环境变量）；prod 构建完全由 env 驱动。embed 的前端资产对桌面版冗余但无害（保留独立服务器分发能力，且 Tauri 的 `frontendDist` 与 `go:embed` 共用同一构建产物 `server/web_dist`）。

## 2. 目标架构

```
┌─ Tauri 2 App (Rust 主进程) ─────────────────────────────┐
│  启动：创建窗口(hidden) → 取 window.url() 的 origin      │
│        → 选空闲端口 + 生成 256bit token                  │
│        → spawn sidecar(env: PORT/HOST/DB/KEY/TOKEN/     │
│          ALLOWED_ORIGINS=webview origin) → 健康轮询     │
│  退出：POST /api/shutdown(Bearer) → 等待≤5s → kill      │
│                                                          │
│  ┌─ WebView (tauri://localhost 等稳定 origin) ────────┐ │
│  │  React SPA（Tauri 打包的静态资产，非 Go embed）      │ │
│  │  REST: http://127.0.0.1:<port> + Authorization     │ │
│  │  WS:   ws://127.0.0.1:<port>/ws?...&access_token=  │ │
│  └────────────────────────────────────────────────────┘ │
│        ↕ IPC(invoke/listen)：窗口控制、后端信息、        │
│          文件拖出、磁盘保存、设置迁移、更新检查           │
└────────────────────────┬─────────────────────────────────┘
                         │ 127.0.0.1 HTTP/WS (loopback only)
              xcontrol-server sidecar（-tags prod，externalBin 打包）
                         │ SSH/SFTP
                      远程主机
```

与 Electron 的本质差异只有两点：前端 origin 从"后端动态端口"变为"Tauri 固定 origin"（localStorage 因此稳定可用）；鉴权从 HttpOnly Cookie 变为 Bearer（REST）+ query token（WS）。安全边界不变：token 仅存于 Rust 主进程、Go 子进程环境与 WebView 内存中的 JS 变量，不落 localStorage。

## 3. 仓库布局

```
/workspace
├── package.json                 [新增] @tauri-apps/cli + desktop:* 脚本
├── src-tauri/                   [新增] Tauri 2 应用
│   ├── Cargo.toml
│   ├── tauri.conf.json          基础配置
│   ├── tauri.macos.conf.json    平台覆盖（Overlay 标题栏等）
│   ├── tauri.windows.conf.json / tauri.linux.conf.json（frameless 等）
│   ├── capabilities/default.json
│   ├── icons/                   tauri icon 生成
│   ├── binaries/                构建时放入 xcontrol-server-<triple>[.exe]
│   └── src/
│       ├── main.rs / lib.rs     插件注册、单实例、smoke 分支
│       ├── backend.rs           sidecar 生命周期（spawn/health/shutdown/kill）
│       ├── http.rs              极简 loopback HTTP 客户端（std TcpStream）
│       ├── commands.rs          invoke 命令（见 §5.5）
│       ├── drag_out.rs          远程文件物化 + startDrag + temp 清理
│       └── settings_migrate.rs  settings.json → localStorage 一次性迁移
├── web/                         [修改] 前端（见 §6）
├── server/                      [微改] 仅 AccessToken 中间件
├── scripts/
│   ├── desktop-dev.mjs          [新增] dev 前置：go build + triple 拷贝
│   └── desktop-build.mjs        [新增] 构建编排（替代 electron/build.sh）
├── .github/workflows/build-desktop.yml  [重写]
└── electron/                    [最终删除] 迁移验收后移除
```

**移动端预留**：Rust 侧所有桌面专属逻辑（sidecar、窗口、拖出、更新、单实例）从 P0 起用 `#[cfg(desktop)]` 门控，commands 同样门控；`lib.rs` 保持 `#[cfg(mobile)]` 空实现占位。这样未来 `tauri ios init` / `tauri android init` 时桌面代码零干扰（详见 §14）。

## 4. 后端（Go）改动 — 仅 1 处代码 + 测试

`server/gateway/middleware/auth.go`：`tokenMatches` 增加查询参数分支：

```go
} else if token := r.URL.Query().Get("access_token"); token != "" {
    // 浏览器 WebSocket 无法携带自定义 Header，桌面端 WS 鉴权走 query
}
```

- `auth_test.go` 增加 query 参数用例（有效/无效/优先级：Header > Cookie > Query）。
- CORS、WS `OriginPatterns`、日志均**零改动**（依据 §1.1/§1.2）。
- `XCONTROL_ALLOWED_ORIGINS` 由 Rust 启动时传入 WebView 实际 origin（`window.url()` 推导，无需硬编码三平台差异）。

## 5. Rust 桌面壳设计

### 5.1 依赖

```toml
tauri = "2"
tauri-plugin-single-instance   # 单实例锁（二次启动聚焦主窗口）
tauri-plugin-opener            # 外部链接 → 系统浏览器
tauri-plugin-dialog            # 保存文件对话框（下载/导出）
tauri-plugin-updater           # 自动更新
tauri-plugin-process           # 更新后 relaunch
tauri-plugin-drag              # 文件拖出（crabnebula 社区插件）
serde / serde_json, dirs, getrandom
# 不引入 reqwest/ureq：所有后端请求均为 loopback 明文 HTTP，
# 用 std::net::TcpStream 手写 ~80 行 HTTP/1.1 客户端（http.rs）
```

不引入 `tauri-plugin-shell`：sidecar 用 `bundle.externalBin` 打包、`std::process::Command` 自行 spawn（需要 env 注入、stdio 重定向到日志文件、Windows `CREATE_NO_WINDOW`，std 全都直接支持，且权限面最小）。

### 5.2 启动时序

```
main() → 注册插件 → setup:
  1. 取主窗口（tauri.conf.json 定义，visible:false）→ origin = window.url() origin
  2. pick_free_port()（TcpListener bind 127.0.0.1:0 后释放，同 Electron）
  3. token = 32 字节随机 base64url（getrandom）
  4. 数据目录 = dirs::data_dir()/XControl（复用 Electron，见 §9）
  5. spawn xcontrol-server：
     env: XCONTROL_PORT/HOST=127.0.0.1/DB_PATH/KEY_PATH/ACCESS_TOKEN/
          ALLOWED_ORIGINS=<origin>/LOG_LEVEL=info
     stdio → <数据目录>/logs/backend.log（追加）
     Windows: creation_flags(CREATE_NO_WINDOW)
  6. 后台任务：轮询 GET /api/health（200ms×15s），结果写入 OnceCell<BackendInfo>
  7. 前端 invoke('get_backend_info') 阻塞等待 OnceCell → { port, token }
  8. 前端完成初始化后 invoke('frontend_ready') → Rust show()+maximize()
     （等价 Electron ready-to-show + maximize，避免白屏闪现）
  9. 启动时清扫 temp 下 24h 以上的 xcontrol-drag-* 目录（同 Electron）
```

sidecar 路径解析：prod → `resource_dir()/xcontrol-server-<target_triple><exe后缀>`；dev → `XCONTROL_SERVER_PATH` 环境变量或 `../server/xcontrol-server`（同 Electron `getBackendExecutable`）。

### 5.3 退出时序（与 Electron 逐条对齐）

`RunEvent::ExitRequested` / 全窗口关闭 → `POST /api/shutdown`（Bearer，1.5s 超时）→ 等待子进程退出 ≤5s → 未退则强杀（Unix SIGKILL / Windows TerminateProcess）→ 兜底：进程 Drop guard 强杀（对应 Electron `process.on('exit')`）。

### 5.4 窗口配置（平台覆盖文件）

| 平台 | 配置 |
|---|---|
| macOS | `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `decorations: true`, `trafficLightPosition: {x:12, y:13}`（对齐现 Electron 值，实现时按标题栏高度微调） |
| Windows/Linux | `decorations: false`（前端自绘右侧按钮，现有 UI 不变） |
| 共有 | 1280×800 / min 900×600 / `visible: false` / `backgroundColor: "#0A0A0A"` / `dragDropEnabled: true`（显式声明） |

### 5.5 Tauri Commands（IPC 面）

| 命令 | 签名/说明 |
|---|---|
| `get_backend_info` | `() → { port: u16, token: String }`，阻塞至后端就绪（超时返回错误 → 前端展示含日志路径的错误提示，同 Electron dialog.showErrorBox） |
| `frontend_ready` | 显示并最大化窗口 |
| `get_platform` | `() → "macos" \| "windows" \| "linux"`（替代 `process.platform`，注意前端 `isMac()` 判断值从 `'darwin'` 改为 `'macos'`） |
| `migrate_electron_settings` | `() → Option<{ "xcontrol-settings": String }>`；读 `<数据目录>/settings.json`，成功后写 marker 文件 `.tauri-migrated`，二次调用返回 None |
| `sftp_drag_out` | `(source_session_id, local_session_id, paths) → Result<Vec<String>>`：物化远程文件到 temp（调后端 `/api/sftp/transfer` + 轮询 `/api/sftp/transfers`，移植 `materializeRemoteDrag`，含同名检测/超时/temp 登记清理），返回本机文件路径列表；前端接着调 drag 插件 `startDrag({ item: paths, icon })`。1h 后清理 temp 目录 |
| `save_url_to_disk` | `(api_path, suggested_name) → Result<Option<String>>`：流式 GET 后端（Bearer）→ temp → 保存对话框 → 移动到用户选择路径。用于备份导出/SFTP 下载（大文件不进 IPC） |
| `save_blob_to_disk` | `(bytes: Vec<u8>, suggested_name)`：用于前端生成的小文件（私钥导出） |

**事件**（Rust → 前端 emit）：`backend-exited`（后端意外退出时通知前端展示错误并阻止继续操作，Electron 没有此能力，顺带增强）。

### 5.6 capabilities/default.json

```jsonc
{
  "permissions": [
    "core:default",
    "core:window:allow-minimize", "core:window:allow-toggle-maximize",
    "core:window:allow-close", "core:window:allow-is-maximized",
    "core:webview:allow-internal-toggle-drag-region",  // 按需
    "drag:default", "opener:default", "updater:default",
    "process:allow-restart", "dialog:default"
  ]
}
```

CSP 保持 `null`（现状 Go 静态服务也未下发 CSP，保持一致；后续可作为独立加固项）。

### 5.7 Smoke 测试

`--smoke-test` 参数分支：正常启动流程 + 隐藏窗口 → Rust 侧断言：① health 204；② 带 Bearer `GET /api/groups` = 200；③ 无 Bearer = 401；④ 响应含 `Access-Control-Allow-Origin: <origin>`；⑤ 优雅退出后子进程退出 → 打印 `XCONTROL_TAURI_SMOKE_OK`，exit 0。CI Linux 上用 `xvfb-run` 执行（WebKitGTK 需要 X display）。比 Electron 版更严格（Electron 只验证了 cookie 路径）。

## 6. 前端改动（web/src）

### 6.1 新增 `lib/desktop.ts`（桌面桥，替代 `window.xcontrol`）

```ts
isTauri(): boolean                  // '__TAURI_INTERNALS__' in window
await initDesktop(): Promise<void>  // Tauri: invoke(get_backend_info)→存模块级 {baseUrl, token}
                                    //       + 设置迁移(§9)；浏览器: 立即 resolve，baseUrl=''
apiBase(): string                   // '' | 'http://127.0.0.1:<port>'
authHeaders(): Record<string,string>// {} | { Authorization: Bearer ... }
wsUrl(path, params): string         // 浏览器: 相对路径同源；Tauri: ws://127.0.0.1:<port>/...&access_token=
openExternal(url): void             // Tauri: opener.openUrl；浏览器: window.open
saveToDisk(...)                     // Tauri: invoke(save_url_to_disk / save_blob_to_disk)；浏览器: 现有 blob+anchor
```

### 6.2 bootstrap 时序（`main.tsx`）

```ts
await initDesktop()        // 先于一切 store 导入（保证迁移先于 zustand persist 水化）
const { App } = await import('./App')   // 动态导入
render(<App />) → 首帧后 invoke('frontend_ready')
```

浏览器模式 `initDesktop` 同步返回，零开销。

### 6.3 API 层

- `client.ts`：`BASE_URL` 改为 `apiBase()`，所有请求附加 `authHeaders()`。
- 4 处裸 `fetch`（`backup.ts` 导出/上传、`sftp.ts` 上传/`fetchDownloadFile`）统一改走带鉴权封装。
- 3 处 WS URL 构造（`useWebSocket.ts`、`useSftpTransfer.ts`、`useServerMetrics.ts` 的 `window.location.host` 拼接）统一改用 `wsUrl()`。

### 6.4 窗口控制与标题栏

- `useWindowControls.ts` 重写：`getCurrentWindow()`（`@tauri-apps/api/window`）的 minimize/toggleMaximize/close/isMaximized；最大化状态同步用 `onResized` → 重查 `isMaximized()`（覆盖 Win+↑/↓、边缘拖拽、双击标题栏）。`isMac()` 判断值改 `'macos'`。
- 标题栏拖拽：`app-shell.css` 的 `-webkit-app-region: drag/no-drag` **Tauri 下无效**，改为在 `<header>` 及 `.header-left`/`.header-right` 容器加 `data-tauri-drag-region` 属性（属性仅对该元素自身的 mousedown 生效，内部按钮/搜索框天然不受影响，现有 `no-drag` CSS 可删）。
- 外链：`useTerminal.ts` `openLink` 与 `ProviderForm` OAuth 改走 `openExternal()`（`ProviderForm` 现在的 `window.open` 在 Electron 中本来就被转到了系统浏览器，行为不变）。

### 6.5 设置存储简化 + 迁移

- `settings.ts`：删除 `createSettingsStorage` 的桌面分支，统一 localStorage（origin 稳定后可持久化）。浏览器/桌面行为一致。
- 一次性迁移见 §9.2。

### 6.6 内部拖拽 pointer 重构（本方案最大的前端工作量）

**共用设施** `hooks/usePointerDrag.ts` + `lib/dragRegistry.ts`：

- pointerdown → 移动超过 4px 阈值进入拖拽态（区分点击/右键/上下文菜单）→ `setPointerCapture`，自绘 ghost（复用 `.sftp-drag-ghost` 样式）跟随光标 → pointermove 时 `document.elementFromPoint()` 命中注册的 drop 目标 → 高亮 + 跟踪 Ctrl/Alt（copy/move）→ pointerup 提交，Escape 取消。
- `dragRegistry`：各拖放表面注册 `(element, metadata)`（SFTP：pane/tabId/kind/destDir，即现有 `SftpDropTarget` 模型原样保留；Sidebar：group id）。**store 层（`beginDrag/setDropTarget/commitDrop/validateDrop` 等）逻辑不动，只换事件管道**。

**SFTP**（`FilePane/FileRow/FileTree/Breadcrumb/PaneTabs`）：`onDragStart/onDragOver/onDrop` 处理器替换为 pointer 管道 + 注册目标。

**Sidebar**（拖服务器进分组）：同管道，`text/profile-id` 变为拖拽 session 中的普通载荷。

**拖出触发**（顺带把休眠功能接上）：拖拽态中检测 pointer 移出窗口客户区（`clientX/Y` 越界）→ 中止 pointer 拖拽 → `invoke('sftp_drag_out', ...)` 物化 → `startDrag({ item: paths, icon })` 走原生拖出。另在 SFTP 右键菜单加"导出到本机…"作为可发现的兜底入口。

### 6.7 外部文件拖入

- 新增 `hooks/useExternalDrop.ts`：`getCurrentWebview().onDragDropEvent` 监听 `enter/over/drop/leave`，`drop` 时用 `elementFromPoint` + registry 命中目标 → 复用 `importExternalPaths(localSessionId, paths, target)`（本地会话默认自动连接，天然可用；无本地会话时 toast 提示）。
- **优于 Electron**：直接拿 OS 真实路径，文件夹拖入也天然支持（`directory_mode: 'preserve'` 后端已支持），不再需要 `webUtils.getPathForFile`。
- `SftpView` 的 `fileDrag.onStatus` toast 逻辑保留，改由 `sftp_drag_out` 的 invoke 结果驱动。
- 浏览器模式（无 Tauri）：现有 HTML5 drop + `uploadExternalFiles` 流式上传路径保留（桌面/浏览器双路径，按 `isTauri()` 分支）。

### 6.8 删除项

`types/desktop.d.ts`（`window.xcontrol` 全部类型）、`settings.ts` 桌面存储分支、CSS `-webkit-app-region` 规则。

## 7. 构建与打包

### 7.1 根 `package.json`（新增，最小化）

```jsonc
{
  "name": "xcontrol",
  "private": true,
  "scripts": {
    "desktop:dev": "node scripts/desktop-dev.mjs && tauri dev",
    "desktop:build": "node scripts/desktop-build.mjs && tauri build",
    "desktop:smoke": "…--smoke-test"
  },
  "devDependencies": { "@tauri-apps/cli": "^2" }
}
```

`web/package.json` 增 `@tauri-apps/api` 及插件 JS 包（`@tauri-apps/plugin-opener/dialog/updater/process`、`@crabnebula/tauri-plugin-drag`）。

### 7.2 构建编排（`scripts/desktop-build.mjs`，替代 `electron/build.sh|ps1`）

```
1. cd web && npm ci && npm run build        → server/web_dist（Tauri frontendDist 指向此处，与 go:embed 共用）
2. cd server && CGO_ENABLED=0 go build -tags prod -o xcontrol-server[.exe] .
3. 拷贝重命名 → src-tauri/binaries/xcontrol-server-<triple>[.exe]
   triple 由 `rustc -vV` 解析（三平台均本机构建，无交叉编译，不再需要 wine）
4. tauri build
5. 产物：win:   XControl-Setup-<v>-x64.exe（NSIS，installMode: currentUser）
        mac:   XControl-<v>-arm64.dmg
        linux: XControl-<v>-amd64.deb + x64.rpm + amd64.AppImage
```

`tauri.conf.json` 关键项：`identifier: "com.yuweinfo.xcontrol"`、`productName: "XControl"`、`frontendDist: "../server/web_dist"`、`devUrl: "http://localhost:5173"`、`beforeDevCommand: "npm --prefix web run dev"`、`bundle.externalBin: ["binaries/xcontrol-server"]`、`createUpdaterArtifacts: true`。

图标：`tauri icon electron/icon.png` 一次性生成 `src-tauri/icons/`。

## 8. CI/CD 与自动更新

### 8.1 `build-desktop.yml` 重写要点

- **prepare job 不变**（stable/pre 判定、版本号计算），但 pre 版本格式改为 `0.0.0-pre.<yyyymmdd>.<sha7>` —— semver pre-release 按标识符字典序比较，纯 sha 不单调会导致 updater 漏更，加日期前缀保证单调。
- **matrix 收窄为 3 个**：`windows-latest` / `macos-latest`（天然 arm64）/ `ubuntu-latest`（deb+rpm+AppImage；保留 `binutils rpm` 安装步骤，另加 Tauri Linux 依赖 `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` 等）。
- **新增 Rust 工具链**：`dtolnay/rust-toolchain@stable` + `swatinem/rust-cache@v2`（缓存 `src-tauri` target）。
- 版本注入：node 脚本改写 `src-tauri/tauri.conf.json` 的 `version`（替代原来改 `electron/package.json`）。
- 构建发布改用 `tauri-apps/tauri-action@v0` 的 **draft release 聚合模式**：三平台 job 各自 `releaseDraft: true` 上传，`includeUpdaterJson: true` 自动聚合生成 `latest.json`；最后一个 job 发布（stable 正式 / pre 标 prerelease）。macOS 签名 secrets 改用 Tauri 命名（`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`），未配置则自动跳过（保持现状的可选签名）。
- **updater 签名**：本地 `tauri signer generate` 生成密钥对 → 公钥写进 `tauri.conf.json`，私钥与密码入 secrets（`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`），tauri-action 自动产出 `.sig` 与 `latest.json`。

### 8.2 更新通道策略

- endpoint：`https://github.com/AfterYuWei/XControl/releases/latest/download/latest.json`。
- `latest.json` 只随 **stable** Release 生成 → stable 用户只收到 stable；pre 用户（版本 `0.0.0-pre.*` 语义上低于任何正式版）会在 stable 发布时收到升级。
- **平台限制（写进发布说明）**：Windows NSIS、macOS app、Linux **AppImage** 支持应用内更新；deb/rpm 不支持（官方限制，用户手动升级）。
- 前端 UI：设置对话框加"检查更新"（`check() → downloadAndInstall() → relaunch()`）+ 启动时静默检查（延迟 10s，避免抢启动带宽）。

## 9. 数据与设置迁移

### 9.1 数据目录复用（对现有用户无感）

Rust 侧统一使用 `dirs::data_dir()/XControl`：

| 平台 | 路径（= Electron userData） |
|---|---|
| Windows | `%APPDATA%\XControl` |
| macOS | `~/Library/Application Support/XControl` |
| Linux | `~/.config/XControl` |

`XCONTROL_DB_PATH=<dir>/xcontrol.db`、`XCONTROL_KEY_PATH=<dir>/key`、日志 `<dir>/logs/backend.log`。数据库/密钥/备份目录（`<dir>/backups`，main.go 由 DB 路径派生）**零迁移自动继承**。Tauri 自身的 app data（WebView localStorage 等）走默认 identifier 目录，与此互不干扰。

### 9.2 settings.json → localStorage 一次性迁移

Electron 的 `settings.json` 结构为 `{"xcontrol-settings": "<zustand persist JSON>"}`（与 localStorage 键/值完全同构）。迁移即：`initDesktop()` 中 `invoke('migrate_electron_settings')` → 返回值存在且 localStorage 无 `xcontrol-settings` 时写入 → Rust 写 marker。因 `main.tsx` 先 `await initDesktop()` 再动态导入 App，zustand persist 水化时迁移已就绪。**老用户主题/字体/侧栏宽度全部保留**。

## 10. 测试与验收

| 层 | 内容 |
|---|---|
| Go | `go test ./...`（新增 auth query 用例）；`go vet ./...` |
| 前端单测（Vitest） | `wsUrl()`/`apiBase()` 构造、pointer-drag 状态机（阈值/取消/修饰键）、迁移写入逻辑 |
| Rust | `cargo test`（http.rs 循环请求、triple 路径解析、settings 迁移 marker）；`cargo clippy` |
| Smoke | 三平台 `--smoke-test`；CI Linux `xvfb-run`（quality.yml 可加常驻 job） |
| 手动验收清单 | 三平台分别过：首启窗口/数据继承（旧库打开连接列表）/终端+补全/中文与 emoji 渲染（Unicode11）/WebGL 降级/SFTP 双面板拖拽（含 Ctrl 复制）/OS 文件拖入（含文件夹）/拖出到桌面/备份导出私钥导出落盘/OAuth 授权闭环/⌘K/深浅主题/最大化同步（Win+↑/双击标题栏/边缘拖拽）/单实例聚焦/退出后无孤儿进程/应用内更新（arm64 mac 与 AppImage 各验一次） |

## 11. 实施阶段

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **P0 脚手架** | src-tauri 初始化、图标、窗口配置、sidecar spawn/健康/退出、根 package.json、build 脚本 | `desktop:build` 三平台出包，能手动装跑（前端尚无桌面能力） |
| **P1 通信桥** | 后端 query token、desktop.ts、client/WS 改造、bootstrap 时序、设置迁移、smoke | smoke 通过；桌面版功能与浏览器版等价（除拖拽/下载） |
| **P2 窗口与系统能力** | useWindowControls、drag-region、openExternal、下载保存（save_url/save_blob） | 手动清单中窗口/外链/下载项全过 |
| **P3 拖拽** | usePointerDrag + registry、SFTP/Sidebar 重构、外部拖入、拖出 + 菜单兜底 | 拖拽验收项全过（重点 Windows） |
| **P4 打包/CI/文档/清理** | tauri-action、updater、签名 secrets、版本策略、重写 DESKTOP_RUNTIME.md、更新三个 AI 指导文档（CODEBUDDY/AGENTS/CLAUDE）、删除 electron/ | CI 三平台绿，tag 出正式 Release 含 latest.json |

P0–P1 完成即可替换日常使用（拖拽 P3 前降级为按钮/菜单操作），风险后置。

## 12. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| `dragDropEnabled` 与 HTML5 DnD 互斥影响面超预期（已发现含 Sidebar） | 高 | pointer 重构覆盖全部内部 DnD；P3 前先在 Win/mac/linux 各做一次 10 分钟 spike 验证 `onDragDropEvent` 行为，必要时调整目标命中策略 |
| WKWebView/WebKitGTK 的 blob 下载、WebGL（xterm）、Monaco 兼容性 | 中 | 下载走 Rust 保存兜底；xterm 已有 Canvas 降级路径；Monaco 在三 webview 均有生产先例，P2 手动验证 |
| `tauri-plugin-drag` 为社区维护（crabnebula） | 中 | 版本锁定；最坏情况降级为"导出到本机"菜单（Electron 时代该功能本就未接线，无回归） |
| macOS Overlay 标题栏未聚焦时无法拖动（Tauri 已知 issue #4316） | 低 | 与 Electron hiddenInset 体验差异极小；必要时切 `Transparent` 样式 |
| updater 的 deb/rpm 不支持 | 低 | 发布说明明示 + 主推 AppImage |
| OAuth 回调页在外部浏览器（现状即如此） | 低 | 保持现状；后续可做 deep-link 增强（独立需求） |

## 13. 文档与清理

- `docs/DESKTOP_RUNTIME.md`：重写为 Tauri 版（启动/安全边界/退出流程/验证命令，保留"令牌不进 localStorage、仅存于 Rust 进程/Go 环境/WebView 内存"的表述，更新为 Bearer+query 机制）。
- `CODEBUDDY.md` / `AGENTS.md` / `CLAUDE.md`：桌面打包章节改为 `src-tauri/`，命令、架构描述、开发流程同步更新。
- 新增 `src-tauri/README.md`（构建/开发/签名/更新密钥操作手册）。
- 验收后删除 `electron/` 全目录及 `.github/CI.md` 中 Electron 相关描述（更新为 Tauri 产物表）。

## 14. 移动端前瞻（iOS/Android）

Tauri 2 框架层面原生支持移动端（iOS/Android 自 2.0 GA 起稳定，前端代码与 Rust 逻辑通过 `#[cfg(desktop)]` / `#[cfg(mobile)]` 门控共享），但 XControl 引入移动端有两个必须正视的约束：

### 14.1 硬约束：sidecar 子进程模式在移动端不可用

- iOS 沙箱**禁止应用 spawn 子进程**，Tauri 的 `externalBin`/sidecar 是桌面专属能力。
- 因此 `xcontrol-server` 在移动端必须换形态，可选路线：

| 路线 | 做法 | 工程量 | 说明 |
|---|---|---|---|
| **A. 进程内嵌入** | Go 用 `gomobile bind`（或 cgo archive）编译为 iOS Framework / Android AAR，在 App 进程内跑 loopback HTTP；Rust 通过 C FFI 调 start/stop。`modernc.org/sqlite` 纯 Go 支持 iOS/Android，业务代码全部复用 | 中偏大 | 保持"本地完整功能"的产品形态；Go 侧需加一层 cgo export 桥 |
| **B. 薄客户端** | 手机 App 不起本地后端，直连自部署的 xcontrol-server（`-tags prod` 的独立服务器模式已存在，含 go:embed 前端） | 小 | 产品形态变为"远程网关"；Bearer/WS token + CORS 机制可原样复用 |

### 14.2 插件与能力兼容表（本方案所选）

| 能力 | 移动端 | 处理 |
|---|---|---|
| `tauri-plugin-opener` / `dialog` | ✅ 支持 | 直接可用 |
| `tauri-plugin-single-instance` | ❌ 桌面专属 | 移动端不需要（OS 管理应用生命周期），cfg 门控 |
| `tauri-plugin-updater` / `process` | ❌ 桌面专属 | 移动端更新走 App Store / Play Store，cfg 门控 |
| `tauri-plugin-drag`（拖出） | ❌ 桌面专属 | 移动端用分享面板（share sheet）/文档选择器替代，产品层重新设计 |
| 窗口控制 / drag-region / `dragDropEnabled` | ❌ 不适用 | cfg 门控 |

### 14.3 本次迁移为移动端预留的动作（已并入实施要求）

1. **Rust 代码 cfg 门控（P0 起）**：`backend.rs`（sidecar）、`drag_out.rs`、窗口/更新/单实例相关插件注册与命令全部 `#[cfg(desktop)]`；`#[cfg(mobile)]` 留空实现占位。
2. **前端能力探测模式天然可扩展**：`lib/desktop.ts` 的 `isTauri()` 体系未来加 `isMobile()` 分支即可；本次迁移强化的"浏览器可用性"（桌面能力全部可选降级）正是移动端复用的基础。
3. **通信层机制可直接复用**：Bearer + `?access_token=` + origin 白名单在移动端 WebView（同样有稳定自定义 origin）机制相同。
4. **UI 层为最大变量**：xterm.js 的触屏软键盘体验、pointer 拖拽重构（恰好天然支持 touch）之外的移动交互重设计，属于独立的产品工程，不阻塞本次迁移。

### 14.4 结论

Tauri 2 **可以胜任**移动端编译与壳层复用（前端共享、插件大部分兼容、Rust 门控共享），且本方案的架构（稳定 origin + Bearer/query token + 可选降级的前端能力层）是有意为移动端留了路的。真正的移动端成本不在 Tauri，而在：① Go 后端的进程内嵌入改造（路线 A）或产品形态调整（路线 B）；② 终端类应用的移动交互重设计。另注意 Tauri 官方在 GA 回顾中也承认移动端生态仍在完善中（部分插件桌面/移动不等价），建议按"架构预留、按需启动"推进，不在本次迁移范围内展开。

## 15. 双分支独立 CI/CD 策略（过渡期）

迁移在 `tauri` 分支上进行，`main` 分支的 Electron 版持续可用，两分支 CI 完全独立。

### 15.1 独立机制：per-ref 工作流版本

GitHub Actions 的 `push` 事件只读取**被推送 ref 上**的工作流文件版本。因此：

| 事件 | 执行的工作流 | 产物 |
|---|---|---|
| 推送 `main` | main 上的 `build-desktop.yml`（Electron 版，保持原样） | Electron 安装包 |
| 推送 `tauri` | tauri 上的 `build-desktop.yml`（Tauri 版，本方案 §8） | Tauri 安装包 |
| 打 tag `v*`（main 提交上） | Electron 版 | 正式 Electron Release |
| 打 tag `tauri-v*`（tauri 提交上） | Tauri 版 | 正式 Tauri Release |

两分支互不干扰、无需任何条件判断；`quality.yml` 同理（frontend/backend 两个 job 双分支共用逻辑，桌面 job 各自版本）。

### 15.2 触发与命名（tauri 分支上的工作流文件）

- `build-desktop.yml`：`branches: [tauri, main]` + `tags: [tauri-v*, v*]`。包含 `main`/`v*` 是为了**合并回 main 时零修改**（合并后本文件替换 Electron 版自动接管 main 的构建）。
- pre 版（tauri 分支推送）：版本 `0.0.0-pre.<yyyymmdd>.<sha7>`，Release tag `tauri-<sha7>`（加 `tauri-` 前缀避免与 main 分支 Electron pre 版的 `<sha>` tag 命名冲突）。
- stable 版（`tauri-v*` tag）：版本 = tag 去前缀，Release 名 "XControl x.y.z (Tauri stable)"。
- 并发组 `build-desktop-tauri-<ref>`，与 main 的 `build-desktop-<ref>` 不同名，互不取消。

### 15.3 quality.yml 差异

tauri 分支上 `electron-smoke` job 替换为 `desktop` job：cargo fmt --check / clippy -D warnings / cargo test / `xvfb-run cargo run -- --smoke-test`（烟测断言输出 `XCONTROL_TAURI_SMOKE_OK`）。需要 Rust 工具链 + Linux webkit2gtk 依赖。

### 15.4 合并回 main 的检查清单

1. `build-desktop.yml` / `quality.yml`：无需修改（触发条件已含 main / v*）。
2. 删除 `electron/` 目录（P4 验收后）。
3. 重写 `docs/DESKTOP_RUNTIME.md`、更新 `CODEBUDDY.md`/`AGENTS.md`/`CLAUDE.md`。
4. 首个 Tauri 正式版建议用 `tauri-v*` tag 单独发布一次验证管线，再切回 `v*` 常规发布。
