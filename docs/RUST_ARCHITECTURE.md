# XControl Rust / Tauri 后端架构

> 状态：Phase 1 架构审计基线  
> 基线提交：`57bddcb`  
> 审计日期：2026-09-09

本文记录 XControl `src-tauri` 后端的当前架构、已识别风险、目标模块边界和迁移计划。
它是后续小步重构的约束文档，不代表所有目标目录均已实现。

## Architecture Overview

XControl 是一个标准 Tauri 2 crate。React 前端通过 Tauri command 和 event 与 Rust 后端通信；
SQLite、credential 加密、SSH/SFTP、备份和同步均在 Rust 进程内完成。

当前实际调用链为：

```text
React / web/src/api
  -> lib.rs 中的 generate_handler!
  -> 分散在根模块及各 Feature 内的 Tauri commands
  -> ProfileState / VaultState / SessionState / SftpState / SyncState 等
  -> SQLite / Encryptor / russh / russh-sftp / reqwest / filesystem
```

当前主要依赖关系：

```text
profile/group/snippet/vault commands -> SyncState::notify_change
sync -> backup -> profile/group/vault

sftp::state -> TransferManager
sftp::transfer -> SftpState

sftp -> ssh::transport::ConnectedRoute -> russh handle
```

这些关系形成了业务层与 IPC 的反向依赖、SFTP 内部双向耦合，以及 SSH 底层类型泄漏。

当前正面基础包括：

- SQLite 使用短生命周期独立连接，没有全局 `Connection` mutex；
- SSH 与 scheduler 使用有界 channel；
- SSH session 和 transfer 已使用 `CancellationToken`；
- 未发现全局 `std::sync::MutexGuard` 跨 `.await`；
- 数据库 schema、credential 密文和 backup 格式已有兼容性测试。

## Audit Baseline

### P0 — Correctness / Security

1. SFTP 远端目录归档路径会先将文件读入多个 `Vec<u8>`，再构建完整压缩包，可能因大目录造成
   数倍数据量的内存峰值或 OOM。
2. Sync scheduler 使用 `try_send`；队列满时请求可能被静默丢弃，但 command 仍可能返回
   `started: true`。
3. scheduler、手动同步、cloud pull/push 和 restore 未完全受同一 operation coordinator 保护，
   云端索引 read-modify-write 与数据库恢复存在竞态窗口。
4. Profile、Vault、Backup、Sync 中部分 secret-bearing 类型实现 `Debug` 或大量 `Clone`，
   增加密码、私钥、passphrase、token 和明文备份数据泄漏或复制的风险。

### P1 — Architecture / Ownership

- 94 个 `#[tauri::command]` 分散在业务模块。
- SSH/SFTP spawned task 没有统一保存和等待 `JoinHandle`。
- shutdown 主要执行 cancel/clear，不能保证所有后台任务已经结束。
- Mobile builder 缺少与 Desktop 对等的生命周期清理。
- `ssh::transport::ConnectedRoute` 向 SFTP 暴露 `russh` handle。
- `profiles.rs`、`vault.rs`、`backup.rs`、`ssh/session.rs`、`sftp/state.rs` 和
  `sftp/transfer.rs` 混合了多类职责。
- 内部 storage/domain/protocol 错误过早转换为 IPC `CommandError` 或 `String`。
- desktop/mobile bootstrap 大量重复。

### P2 — Maintainability

- 模型、SQL、use case、command 和测试集中在巨型文件中。
- `pub(crate)` 和 glob re-export 范围偏大。
- `SyncState` 的 inherent impl 分散在多个文件。
- OAuth abandoned pending state 缺少主动清理。
- 远端服务器信息采集默认依赖 Linux shell 和 `/proc`，支持范围未在 API 中表达。

### P3 — Cleanup

- 存在 Go handler/state/manager 迁移形成的复合对象和命名。
- `lib.rs` 同时承担 builder、插件、状态构造、command 注册、deep-link 和 shutdown。
- 部分只服务单一 Feature 的函数仍留在大型根文件中。

## Current File Responsibilities

| 文件 | 当前职责 | 目标归属 | 优先级 |
| --- | --- | --- | --- |
| `main.rs` | 调用 library `run()` | 保留 | P3 |
| `lib.rs` | builder、插件、状态初始化、commands、deep-link、shutdown | `app/` + `commands/` | P1 |
| `commands.rs` | 窗口、ready、日志、设置迁移、文件对话框 | commands + desktop adapter | P1 |
| `database.rs` | SQLite connection、schema、migration | `infrastructure/database/` | P2 |
| `error.rs` | IPC `CommandError` | `commands/error.rs` + typed errors | P1 |
| `credential_crypto.rs` | 兼容加密和 key file | `vault/crypto.rs` + platform paths | P1 |
| `runtime.rs` | 旧数据目录和构建渠道 | `infrastructure/platform/paths.rs` | P1 |
| `settings_migrate.rs` | Electron 设置迁移 | desktop platform adapter | P2 |
| `drag_out.rs` | drag-out command、临时文件、路径转换 | SFTP command + desktop adapter | P1 |
| `audit.rs` | 模型、SQL、command | `audit/model.rs`, `repository.rs` | P2 |
| `groups.rs` | 模型、验证、CRUD SQL、command、sync 通知 | `group/` | P1 |
| `snippets.rs` | 模型、验证、CRUD SQL、command、sync 通知 | `snippet/` | P1 |
| `profiles.rs` | DTO、CRUD、Vault、加密、连接解析、host key、command | `profile/` | P1 |
| `vault.rs` | 模型、CRUD、加密、keygen、Profile 引用、审计、command | `vault/` | P0/P1 |
| `backup.rs` | 格式、KDF、加密、跨域 SQL、导入导出、dialog command | `backup/` | P0/P1 |
| `server_detail.rs` | 远端脚本、解析、指标、command | `server_detail/` | P2 |
| `ssh/mod.rs` | 子模块和重导出 | 收窄 Feature API | P2 |
| `ssh/transport.rs` | TCP/proxy/jump/auth/host key | SSH transport boundary | P1 |
| `ssh/session.rs` | session、registry、PTY、事件、command、OSC | SSH session/service/manager | P1 |
| `ssh/profile_test.rs` | Profile 连接测试和 command | use case + external command | P2 |
| `sftp/mod.rs` | 广泛重导出 | 收窄 Feature API | P2 |
| `sftp/backend.rs` | 本地/远端文件操作和路径转换 | remote backend + platform file access | P1 |
| `sftp/state.rs` | session registry、连接、CRUD、编辑器、事件、command | SFTP session/service/manager | P1 |
| `sftp/transfer.rs` | 任务、上传、归档、复制移动、事件、command | `sftp/transfer/` | P0/P1 |
| `sync/mod.rs` | 模块和 command 重导出 | 收窄 Feature API | P1 |
| `sync/model.rs` | settings/provider/version/event DTO | model + secret-safe views | P0/P2 |
| `sync/store.rs` | Sync SQLite persistence | `sync/repository.rs` | P1 |
| `sync/manager.rs` | 状态、备份协调、恢复、版本和 operation lock | `sync/service.rs` | P0/P1 |
| `sync/scheduler.rs` | 调度、队列、shutdown backup | scheduler + explicit ownership | P0 |
| `sync/oauth.rs` | OAuth state、URL、callback、token exchange | Sync core + callback adapter | P1/P2 |
| `sync/cloud.rs` | provider pull/push、索引、冲突、恢复 | Sync use cases | P0/P1 |
| `sync/provider.rs` | WebDAV/S3/GDrive/OneDrive HTTP | 保持 concrete provider boundary | P1 |

## Module Boundaries

目标依赖方向：

```text
React
  -> Tauri commands / event adapters
  -> Feature facade / use case
  -> Repository / Manager / Connector / Provider
  -> SQLite / SSH / filesystem / cloud / OS
```

禁止依赖：

```text
feature -> commands
repository -> Tauri
database infrastructure -> feature
profile/group/settings -> russh
SSH core -> Tauri AppHandle
cross-platform feature -> desktop adapter
```

小 Feature 只在复杂度真实存在时拆分。不会建立 `service/impl`、单实现 trait、全局
`database/repositories`、`utils` 或 `common` 目录。

## Tauri Command Boundary

所有 `#[tauri::command]` 迁移到 `commands/`。Command 只负责：

1. Tauri `State`/IPC 参数接收；
2. 基础输入转换；
3. 调用高层 Feature API；
4. 将 typed internal error 转换为稳定的 IPC error；
5. 必要的事件分发或 `spawn_blocking` 边界。

Command 不直接执行 SQL、加解密、russh 调用、registry 操作或复杂 Tokio task 管理。
现有 command 名称和前端 payload contract 保持不变。

## Database Boundary

`infrastructure/database` 仅负责：

- 数据库路径和 connection factory；
- SQLite pragma/connection policy；
- schema 和向后兼容 migration。

单域 SQL 位于对应 Feature repository。Backup 的跨域导入导出保留专用 aggregate repository，
以保证单事务导入、ID remapping 和格式兼容，不强行通过多个 repository 拼装事务。

## SSH Runtime Ownership

目标关系：

```text
ProfileService
  -> ConnectionPlan
  -> SshConnector
  -> SshConnection
  -> terminal / exec / sftp channel

SshService
  -> SessionManager
  -> 0..N Session
  -> tracked tasks + cancellation + joined shutdown
```

- `ConnectionPlan` 不包含 Profile repository 或 Tauri 类型。
- `SshConnection` 封装 russh handle，russh 类型不越过 SSH boundary。
- `Session` 只代表单个活动会话。
- `SessionManager` 负责注册、lookup、remove、自然退出回收和 shutdown。
- 后台任务保存 `JoinHandle`，shutdown 执行 cancel 后等待退出。
- Tauri event 通过明确的 event sink adapter 注入。该抽象有平台 adapter 和测试替换需求，
  因而是合理的 dependency inversion，而不是形式化 trait。

## SFTP Runtime Ownership

```text
SftpService
  -> SftpSessionManager
  -> SftpSession / RemoteBackend
  -> TransferManager
  -> tracked TransferTask
```

- SFTP 与 SSH 只通过封装后的连接能力共享底层连接。
- 本地文件访问是平台能力，不与 remote SFTP backend 混为同一套路径假设。
- 上传下载继续使用分块 IPC/流式 IO。
- 目录归档改为流式写入或有限磁盘 staging，禁止将整棵目录加载到内存。
- task 完成后自动回收，并支持 cancel-and-join shutdown。

## Error Strategy

内部错误保持类型和 source chain：

```text
StorageError
VaultError
BackupError
SshError
SftpError
SyncError
PlatformError
```

如果 composition 确实需要，再通过较小的 `AppError` 聚合；不要求所有函数统一一个错误类型。
只有进入 Tauri command 时转换为兼容现有前端的：

```text
IpcError {
    code,
    message,
    references,
}
```

SQLite、russh、reqwest 和 provider 原始响应不得直接暴露给前端。敏感数据不实现 `Debug`，
减少 `Clone`，并在所有权允许时移动或 `zeroize`。

## App State and Ownership

不建立可任意访问所有底层资源的公开 God `AppState`。Tauri 管理高层 concrete facade，
例如 `ProfileService`、`VaultService`、`SshService`、`SftpService`、`SyncService`。

`Database`、`Encryptor`、session/transfer maps 和 provider clients 是 facade 私有实现。
`app::bootstrap` 负责构造和注入，`app::lifecycle` 只保存完成 shutdown 所需的高层句柄。

## Platform Boundary

跨平台核心包括 Profile、Vault、Backup 格式、数据库 repository、SSH 协议、远端 SFTP 和
Sync/cloud 规则。

当前明确的 Desktop-only 能力包括：

- single instance；
- updater；
- drag-out；
- 桌面窗口和标题栏控制；
- Electron 设置迁移；
- 普通本地文件路径选择；
- 任意本地目录访问；
- 桌面日志目录和本机 SSH agent。

这些能力收敛到 `infrastructure/platform/desktop` 及对应 command adapter。Cargo dependency、
插件初始化和 capability 使用 desktop target/cfg 限定。

## Desktop / Mobile Strategy

不复制两套业务模块。目标为：

```text
                    Shared Core Features
                            |
              +-------------+-------------+
              |                           |
       Desktop adapters             Mobile adapters
```

Android/iOS 后续 adapter 重点处理：

- mobile deep-link 和 OAuth callback；
- content URI / file URL / sandboxed document access；
- secure key storage policy；
- app suspend/resume、网络断开、session 恢复；
- 后台任务限制；
- mobile capability 文件。

不会提前创建空的 `android.rs`、`ios.rs` 或完整 `mobile/` 目录。

## Visibility Rules

默认按以下顺序选择最小可见性：

```text
private -> pub(super) -> pub(crate) -> pub
```

- repository、russh wrapper、registry 和内部 DTO 默认私有；
- `mod.rs` 只声明模块和重导出 Feature facade/必要 model；
- 禁止 glob 重导出 command 和内部 state；
- 对前端公开的是 command contract，不等同于 Rust `pub` API。

## Target Directory

目标目录根据实际复杂度逐步形成：

```text
src/
├── main.rs
├── lib.rs
├── app/
│   ├── mod.rs
│   ├── bootstrap.rs
│   ├── lifecycle.rs
│   └── events.rs
├── commands/
│   ├── mod.rs
│   ├── error.rs
│   ├── app.rs
│   ├── audit.rs
│   ├── backup.rs
│   ├── group.rs
│   ├── profile.rs
│   ├── server_detail.rs
│   ├── sftp.rs
│   ├── snippet.rs
│   ├── ssh.rs
│   ├── sync.rs
│   └── vault.rs
├── audit/{mod.rs,model.rs,repository.rs}
├── backup/{mod.rs,model.rs,format.rs,crypto.rs,repository.rs,service.rs}
├── group/{mod.rs,model.rs,repository.rs,service.rs}
├── profile/{mod.rs,model.rs,repository.rs,credentials.rs,connection.rs,service.rs}
├── snippet/{mod.rs,model.rs,repository.rs,service.rs}
├── vault/{mod.rs,model.rs,crypto.rs,repository.rs,service.rs}
├── ssh/
│   ├── mod.rs
│   ├── error.rs
│   ├── transport.rs
│   ├── connection.rs
│   ├── profile_test.rs
│   ├── service.rs
│   ├── session.rs
│   ├── session_manager.rs
│   └── terminal.rs
├── sftp/
│   ├── mod.rs
│   ├── error.rs
│   ├── model.rs
│   ├── backend.rs
│   ├── editor.rs
│   ├── service.rs
│   ├── session.rs
│   ├── session_manager.rs
│   └── transfer/{mod.rs,model.rs,manager.rs,copy.rs,archive.rs}
├── server_detail/{mod.rs,model.rs,parser.rs,service.rs}
├── sync/{mod.rs,model.rs,repository.rs,service.rs,scheduler.rs,cloud.rs,oauth.rs,provider.rs}
└── infrastructure/
    ├── mod.rs
    ├── database/{mod.rs,connection.rs,migration.rs}
    └── platform/
        ├── mod.rs
        ├── paths.rs
        └── desktop/{mod.rs,dialogs.rs,drag_out.rs,logs.rs,settings_migration.rs}
```

目录由复杂度驱动；迁移过程中若某个文件仍然足够小，将保留为单文件模块。

## Migration Plan

每个 Phase 必须保持可编译并形成独立 commit。

### Phase 1 — Architecture Baseline

- 保存本架构文档和审计结论。
- 不修改运行行为。
- 验证 Markdown、Git diff 和工作树。

### Phase 2 — Composition and Infrastructure

- 建立 `app/`、`commands/`、`infrastructure/` 基础边界。
- 将 `database.rs` 拆为 connection 和 migration。
- 调整 `mod` 与 `use` 路径，不改变公开 command。
- 风险：低。

### Phase 3 — Small Feature Boundaries

- 拆 Audit、Group、Snippet 的 model/repository/service。
- 将相应 commands 移入 `commands/`。
- Sync change notification 在 command/use-case orchestration 处处理，不让 repository 依赖 Sync。
- 风险：中。

### Phase 4 — Profile and Vault

- 拆 Profile 模型、repository、credential resolution 和 connection plan。
- 拆 Vault 模型、repository、crypto 和 service。
- 保持 schema、密文、legacy backfill、host key 和 IPC contract。
- 清理 secret `Debug` 和不必要 clone。
- 风险：高。

### Phase 5 — Backup

- 拆 format、crypto、aggregate repository 和 service。
- 保留跨域导入的事务原子性和 ID remapping。
- 文件选择进入 desktop adapter。
- 保持 backup 格式和 Go compatibility fixture。
- 风险：高。

### Phase 6 — SSH Ownership

- 建立 SshService、Session、SessionManager。
- transport 使用自有 ConnectionPlan，并封装 russh handle。
- 跟踪 spawned tasks，实现 cancel-and-join shutdown 和自然退出回收。
- command/event adapter 与核心分离。
- 风险：高。

### Phase 7 — SFTP Ownership

- 建立 SftpService、SessionManager 和独立 TransferManager。
- 消除 `state <-> transfer` 双向依赖。
- 将本地文件访问移入平台边界。
- 修正目录归档的整树内存加载。
- 保持 chunk、IPC、编辑器和传输行为。
- 风险：高。

### Phase 8 — Sync Ownership

- 将 `sync/commands.rs` 迁入 `commands/sync.rs`。
- `store.rs` 改为明确 repository。
- 建立统一 operation coordinator。
- 修正 scheduler backpressure、task tracking 和 shutdown。
- 保持 sync data、cloud object 和 backup 格式。
- 风险：高。

### Phase 9 — Typed Errors

- 引入 Storage/Vault/Backup/SSH/SFTP/Sync/Platform errors。
- 仅在 command 边界生成兼容 IPC error。
- 对底层错误和 provider body 脱敏。
- 风险：中高。

### Phase 10 — Platform Boundary

- target-gate desktop-only dependencies 和插件。
- 收敛 paths/dialogs/logs/drag-out/settings migration。
- 添加 mobile deep-link 与 capability 基础配置。
- 不删除现有 Desktop 功能，不虚构尚无实现的 mobile filesystem adapter。
- 风险：中高。

### Phase 11 — Visibility and Final Verification

- 收窄 visibility 和 re-export。
- 清理迁移后 dead code 和过期命名。
- 更新本文的“目标”状态为实际状态。
- 完成桌面构建、测试和可用条件下的移动端 check。

## Verification Policy

每个 Phase 至少执行：

```bash
cd src-tauri
cargo fmt --all -- --check
cargo check --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked
```

涉及 command、配置或前端 contract 时额外执行：

```bash
npm --prefix web run build
```

最终验收还包括：

- command 名称和 payload 对照；
- schema/migration 快照；
- credential/backup compatibility fixtures；
- shutdown/cancellation 测试；
- 大文件和目录 transfer 测试；
- capability 与 target dependency 检查；
- Windows/macOS/Linux 构建或 CI；
- Android/iOS toolchain 可用后的 `cargo check` 与真机生命周期测试。

## Baseline Verification

在 `57bddcb` 基线上已通过：

```text
cargo fmt --all -- --check
cargo check --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked                # 57 passed, 0 failed
npm --prefix web run build
```

本机仅安装 `x86_64-unknown-linux-gnu` target，因此本阶段未完成 Android/iOS cross-compile。

## Future Extension Rules

1. 新 Feature 优先按业务能力组织，不进入全局 controller/service/dao 层。
2. concrete first；只有多实现、平台差异、dependency inversion 或测试替换有明确价值时创建 trait。
3. 新 command 必须放在 `commands/`，不能把 Tauri 类型引入 Feature core。
4. 新业务 SQL 放在所属 Feature repository；跨域事务需要明确 aggregate owner。
5. russh、russh-sftp、rusqlite 和平台 API 不越过各自 boundary。
6. 新后台任务必须有 owner、取消方式、完成回收和 shutdown 策略。
7. secret-bearing 类型默认不实现 `Debug`，避免非必要 `Clone`，并明确 zeroize 生命周期。
8. Desktop/Mobile 共享业务逻辑，只为真实平台能力建立 adapter。
9. 不创建 `common`、`utils`、`helpers` 垃圾桶。
10. 所有架构迁移保持小步、可编译、可测试，并以独立 commit 记录。
