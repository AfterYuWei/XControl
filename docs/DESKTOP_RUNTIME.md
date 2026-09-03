# Tauri 桌面运行说明

Tauri 2 是 XControl 桌面版的正式运行形态（tauri 分支起，替代 Electron）；Vite Web 模式仅用于开发调试。迁移设计见 `docs/TAURI_MIGRATION.md`。

## 架构

```
Tauri 主进程 (Rust, src-tauri/)
   1. 创建主窗口（visible:false）并推导 webview origin
   2. 申请空闲回环端口 + 生成 256bit 随机访问令牌
   3. spawn xcontrol-server sidecar（externalBin 打包，stdio → logs/backend.log）
      env: XCONTROL_PORT/HOST/DB_PATH/KEY_PATH/ACCESS_TOKEN/ALLOWED_ORIGINS
   4. 健康轮询 /api/health → 前端 invoke('get_backend_info') 取端口+令牌
   5. 前端首帧渲染完成 → invoke('frontend_ready') → 显示并最大化窗口
   6. 退出：POST /api/shutdown（Bearer）→ 等待 ≤5s → 强杀；
      unix 下 PR_SET_PDEATHSIG 兜底（父进程被 SIGKILL 时内核发 SIGTERM）
      ▼
WebView（tauri://localhost 等稳定 origin）
   REST: http://127.0.0.1:<port> + Authorization: Bearer <token>
   WS:   ws://127.0.0.1:<port>/ws?...&access_token=<token>
```

## 启动与安全边界

1. Go sidecar 只监听 `127.0.0.1`，配置完全由环境变量驱动（`-tags prod` 构建）。
2. 访问令牌仅存在于：Rust 主进程、Go 子进程环境、WebView 内存中的 JS 变量
   （`lib/desktop.ts` 模块级状态）。**不写 localStorage、不落磁盘**。
3. REST 请求带 `Authorization: Bearer`；WebSocket 因浏览器 API 无法携带自定义
   Header，走 `?access_token=` 查询参数（优先级 Header > Cookie > Query；
   Logger 中间件只记录 path 不含 query，令牌不进日志）。
4. CORS / WS Origin 放行名单由 Rust 运行时从 `window.url()` 推导后传入
   `XCONTROL_ALLOWED_ORIGINS`（Windows `http://tauri.localhost`、macOS
   `tauri://localhost`、Linux 由 webkitgtk 决定——无需硬编码平台差异）。
5. OAuth 回调不要求桌面令牌（公开路径），在外部系统浏览器完成。

## 用户数据目录（沿用 Electron，无感迁移）

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\XControl` |
| macOS | `~/Library/Application Support/XControl` |
| Linux | `~/.config/XControl` |

内容：`xcontrol.db`、`key`、`backups/`、`logs/backend.log`、Electron 时代的
`settings.json`（首启由 Rust 一次性迁移到 localStorage 后标记 `.tauri-migrated`）。

## 命令

```bash
# 开发（tauri dev：起 vite + 调试构建 + 自动 spawn sidecar）
npm run desktop:dev

# 本地打包（当前平台）
npm run desktop:build

# 烟测（隐藏窗口 + Rust 侧 health/鉴权/CORS 断言，输出 XCONTROL_TAURI_SMOKE_OK）
npm run desktop:smoke

# 手动模拟生产行为（纯 cargo build --release 不启用 custom-protocol，
# 会加载 devUrl —— 必须带 --features，见迁移方案「实施期关键发现」）
cd src-tauri && cargo build --release --features custom-protocol
```

前置依赖：Node.js 22+、Go 1.26+、Rust stable（tauri 分支首次构建需安装
webview 系统库，Linux：`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`）。

## 应用内更新

- 通道：GitHub Releases stable（`latest.json` 只随正式版发布）；
  pre 版本（`0.0.0-pre.<日期>.<sha>`）在 stable 发布时经 semver 比较自动收到升级。
- 支持：Windows NSIS / macOS（app.tar.gz）/ Linux AppImage；
  **deb / rpm 不支持**（官方限制，需手动覆盖安装）。
- 入口：设置 → 关于 → 检查更新；另在启动 10s 后静默检查。
- 签名：`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  两个 GitHub secrets（未配置时 CI 跳过签名，安装包正常出包）。
  本地生成密钥对：`npx tauri signer generate -w <path> --password ""`。

## Web 调试

开发模式不设置 `XCONTROL_ACCESS_TOKEN`，可直接运行：

```bash
cd server && go run .
cd web && npm ci && npm run dev   # http://localhost:5173，/api 与 /ws 代理到 :9090
```

后端与 Vite 默认只监听回环地址。不要在不可信网络中使用无令牌的调试模式。

## 验证

```bash
cd web     && npm run lint && npm run test:unit && npm run build
cd server  && go test ./... && go vet ./...
cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test
npm run desktop:smoke   # 或 CI 中的 xvfb-run cargo run -- --smoke-test
```
