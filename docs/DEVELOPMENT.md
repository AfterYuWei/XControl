# XControl 开发指南

XControl 是基于 React、Tauri 2 与 Rust 的桌面 SSH/SFTP 客户端。所有业务领域都在
Tauri 主进程内运行，前端通过细粒度 command 与 event 通信，不启动本地服务进程。

## 开发环境

- Node.js 22+
- Rust 1.89+
- 各平台的 Tauri 2 系统依赖

```bash
npm ci
npm --prefix web ci
npm run desktop:dev
```

## 验证

```bash
npm --prefix web run test:unit
npm --prefix web run lint
npm --prefix web run build
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

生产构建使用 `npm run desktop:build`。React 产物位于 `web/dist`，由 Tauri 直接打包。

## 架构

Rust 入口在 `src-tauri/src/lib.rs`，启动时按顺序初始化 SQLite、凭据加密、审计、
Profile/Vault/Group/Snippet、备份与同步、SSH 会话和 SFTP 会话。

- `database.rs`：SQLite schema、事务迁移、WAL 与 busy timeout。
- `credential_crypto.rs`：AES-256-GCM 凭据格式与历史数据兼容。
- `profiles.rs`、`vault.rs`、`groups.rs`、`snippets.rs`：本地业务数据。
- `backup.rs`、`sync/`：备份、云 provider、OAuth 与调度器。
- `ssh/transport.rs`：直连、SOCKS5、HTTP CONNECT、SSH jump 与认证。
- `ssh/session.rs`：PTY、终端 I/O、补全、host-key 确认与 Tauri event。
- `sftp/`：会话、文件操作、编辑、上传下载、跨会话传输与拖出物化。
- `server_detail.rs`：通过现有 SSH/SFTP 会话采集主机信息和运行指标。

React 的领域 API 位于 `web/src/api/`，统一使用 `invokeCommand`；实时消息由
`xcontrol-session-message`、`xcontrol-sftp-message` 等 Tauri event 承载。

## 数据与安全

为兼容历史安装，数据仍保存在系统的 `XControl` 用户目录：SQLite 数据库为
`xcontrol.db`，主密钥为 `key`。凭据只在 Rust 内存中解密，连接配置解析结构在析构时清零。
SSH 主机密钥以 SHA-256 指纹验证；未知指纹在成功连接后保存，变化时要求用户确认。

## 前端约定

- 用户可见文本保持中文。
- 新组件优先使用 `web/src/components/ui/` 中的 shadcn/ui。
- 颜色使用语义 CSS 变量，圆角与 `DESIGN.md` 一致。
- 类名合并使用 `cn()`。
- Profile/Group 图标只能使用 `web/src/lib/serverIcons.tsx` 与 `groupIcons.tsx` 的稳定 key。
