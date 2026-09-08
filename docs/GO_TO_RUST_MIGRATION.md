# Go → Rust 全量迁移报告

状态：完成。

## 结果

- 原 1 个 Go module、17 个 package（105 个源文件、19,132 行代码）已按领域逐步迁入
  `src-tauri/src/`。
- SQLite schema、AES-GCM 密文、备份文件、Profile/Vault 数据与 Electron 用户目录保持兼容。
- React 的 REST/WS 适配层已替换为细粒度 Tauri command、event 和二进制 IPC。
- SSH、SFTP、ServerDetail、Backup、Sync、OAuth 与 scheduler 均在 Rust 主进程内运行。
- 发布包不再携带外部业务可执行文件，CI 与构建链只需要 Node.js、Rust 和 Tauri 系统依赖。

## 领域映射

| 原领域 | Rust 实现 | 兼容重点 |
|---|---|---|
| SQLite stores/migrations | `database.rs` + 各领域 repository | schema 版本、WAL、事务与时间格式 |
| credential crypto/vault | `credential_crypto.rs`、`vault.rs` | nonce/ciphertext/tag 与密钥文件 |
| profile/group/snippet/audit | 对应 `*.rs` | JSON 字段、排序、引用约束、审计动作 |
| backup | `backup.rs` | `.xcbackup`、加密、预览与事务导入 |
| sync/providers/OAuth | `sync/` | provider 配置、版本、冲突和调度 |
| SSH transport/session | `ssh/` | 代理、jump、认证、PTY、host key、补全 |
| SFTP/editor/transfers | `sftp/` | 路径、冲突、目录模式、进度、取消、拖出 |
| server detail | `server_detail.rs` | 主机信息和 CPU/内存/磁盘/网络指标 |

## 并发与生命周期

会话和传输使用 `Arc`、Tokio lock、bounded channel、Semaphore 与 CancellationToken。
退出事件会取消所有长生命周期任务，关闭 SSH/SFTP 句柄，并停止同步调度器。敏感连接结构
实现析构清零，host-key 只在完整认证成功后持久化。

## 验收门禁

```bash
npm --prefix web run test:unit
npm --prefix web run lint
npm --prefix web run build
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-features --locked
```

额外静态审计确认：仓库不包含 Go module/source，运行时没有 loopback API、HTTP/WS 网关、
外部业务进程或跨语言 FFI。
