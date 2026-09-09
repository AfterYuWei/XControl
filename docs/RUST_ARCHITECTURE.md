# XControl Rust / Tauri 后端架构

> 状态：架构重构与主机验收完成，等待各原生平台 CI/真机持续验证
>
> 初始审计基线：`57bddcb`
>
> 实现区间：`7f53a8b..HEAD`
>
> 更新日期：2026-09-09

本文是 `src-tauri` 的架构约束、实现说明与审计记录。它描述当前真实代码，不是要求所有
Feature 套用同一模板的目录蓝图。数据库 schema、IPC command 名称、credential 密文、
`.xcbackup` 和 Sync 云端格式均保持兼容。

## Architecture Overview

```text
React / web/src/api
        |
        v
commands/*                 Tauri IPC adapter
        |
        v
Feature facade             ProfileService / SshService / SftpService / ...
        |
        +--> repository    domain-owned SQL
        +--> manager       session / transfer / scheduler ownership
        +--> provider      SSH / SFTP / cloud protocol
        |
        v
infrastructure/*           SQLite connection/migration + platform adapters
```

反向事件通过 feature-owned port 输出：

```text
SSH/SFTP runtime -> SessionEventSink / SftpEventSink
                 -> app::TauriEventSink
                 -> Tauri event -> React
```

## Module Boundaries

- `app`：进程 composition、Tauri plugin、handler、deep-link、event adapter 与 shutdown；
- `commands`：IPC adapter，不拥有业务状态或底层资源；
- feature：model、use case、repository/manager/provider，并通过 `mod.rs` 暴露最小 facade；
- `infrastructure/database`：connection policy 与 schema migration；
- `infrastructure/platform/desktop`：不能在移动端复用的 OS/Tauri 能力；
- SSH/SFTP event trait 定义在使用它的 feature，Tauri 实现在 `app`，依赖指向 port 而不是 adapter。

## Dependency Rules

当前强制依赖方向：

- `commands -> feature -> repository/manager/provider -> external library`；
- `app` 是 composition root，负责构造、插件、state 注册、deep-link 与 shutdown；
- feature、repository 不依赖 `commands`；
- `#[tauri::command]` 只允许存在于 `commands/`；
- `russh` 具体类型只允许存在于 `ssh/`，SFTP 仅通过 SSH 封装的连接能力取得 subsystem；
- 单域 SQL 放在所属 feature repository；schema 和连接策略只在 `infrastructure/database`；
- Desktop API 只存在于 `app`、`commands/desktop`、`commands/backup` 的 desktop 分支和
  `infrastructure/platform/desktop`。

## Implemented Source Tree

```text
src/
├── main.rs
├── lib.rs
├── error.rs
├── server_detail.rs
├── app/
│   ├── mod.rs
│   ├── bootstrap.rs
│   └── events.rs
├── commands/
│   ├── mod.rs
│   ├── audit.rs
│   ├── backup.rs
│   ├── desktop.rs
│   ├── group.rs
│   ├── profile.rs
│   ├── server_detail.rs
│   ├── sftp.rs
│   ├── snippet.rs
│   ├── ssh.rs
│   ├── sync.rs
│   └── vault.rs
├── audit/{mod.rs,model.rs,repository.rs}
├── backup/{mod.rs,error.rs,format.rs,model.rs,repository.rs,service.rs}
├── group/{mod.rs,model.rs,repository.rs,service.rs}
├── profile/{mod.rs,connection.rs,error.rs,legacy.rs,model.rs,repository.rs,service.rs}
├── snippet/{mod.rs,model.rs,repository.rs,service.rs}
├── vault/{mod.rs,crypto.rs,error.rs,model.rs,repository.rs,service.rs}
├── ssh/
│   ├── mod.rs
│   ├── error.rs
│   ├── events.rs
│   ├── profile_test.rs
│   ├── session.rs
│   ├── session_manager.rs
│   └── transport.rs
├── sftp/
│   ├── mod.rs
│   ├── backend.rs
│   ├── error.rs
│   ├── events.rs
│   ├── state.rs
│   └── transfer.rs
├── sync/
│   ├── mod.rs
│   ├── cloud.rs
│   ├── error.rs
│   ├── model.rs
│   ├── oauth.rs
│   ├── provider.rs
│   ├── repository.rs
│   ├── scheduler.rs
│   └── service.rs
└── infrastructure/
    ├── mod.rs
    ├── database/{mod.rs,connection.rs,error.rs,migration.rs}
    └── platform/
        ├── mod.rs
        ├── local_files.rs
        └── desktop/
            ├── mod.rs
            ├── dialogs.rs
            ├── drag_out.rs
            ├── error.rs
            ├── logs.rs
            ├── paths.rs
            └── settings_migration.rs
```

`server_detail.rs`、`sftp/state.rs` 和 `sftp/transfer.rs` 暂时仍是单文件模块：前者是单一远端
采集能力，后两者虽较大，但已拥有清晰 facade/manager 边界。继续拆文件只有在职责继续增长时
进行，避免为了目录对称制造空模块。

## Current File Responsibilities

| 文件 | 当前职责 | 边界/可见性 |
| --- | --- | --- |
| `main.rs` | 调用 library `run()` | binary 入口 |
| `lib.rs` | 声明 crate 模块并导出 Tauri/mobile entry | 不承担 composition 细节 |
| `error.rs` | 稳定、可序列化的 use-case/IPC `CommandError` | 第三方错误先在下层 typed error 收口 |
| `server_detail.rs` | 通过已存在 SSH route 执行远端采集并解析指标 | 不拥有连接，不含 command |
| `app/mod.rs` | app facade | 仅重导出 bootstrap/event adapter |
| `app/bootstrap.rs` | Desktop/Mobile builder、依赖构造、插件、handler、deep-link、shutdown | composition root |
| `app/events.rs` | `SessionEventSink`/`SftpEventSink` 的 Tauri 实现 | feature 不直接依赖 Tauri |
| `audit/backup/group/profile/snippet/vault/ssh/sftp/sync/mod.rs` | 声明 feature 子模块并选择性重导出 facade/model | 不承载业务逻辑 |
| `infrastructure/mod.rs`、`database/mod.rs`、`platform/mod.rs`、`desktop/mod.rs` | 声明基础设施层级及最小 API | desktop module 由 cfg 隔离 |
| `commands/mod.rs` | command 模块注册 facade | crate 内可见；glob 用于携带 Tauri 宏生成的 handler 符号 |
| `commands/audit.rs` | Audit IPC 与 `spawn_blocking` | 无 SQL |
| `commands/backup.rs` | Backup IPC；desktop 文件对话框门控 | 无格式/加密逻辑 |
| `commands/desktop.rs` | 窗口、日志、迁移、保存、drag-out IPC | `#[cfg(desktop)]` |
| `commands/group.rs` | Group IPC 与 Sync change 通知 | 无 SQL |
| `commands/profile.rs` | Profile IPC 与 Sync change 通知 | 无凭据实现 |
| `commands/server_detail.rs` | Server detail IPC | 只调用 use case |
| `commands/sftp.rs` | SFTP IPC、binary body/response 转换 | 不管理 session/transfer map |
| `commands/snippet.rs` | Snippet IPC 与 Sync change 通知 | 无 SQL |
| `commands/ssh.rs` | Profile test 和 SSH session IPC | 不调用 `russh` |
| `commands/sync.rs` | Sync IPC 和阻塞任务切换 | 不实现 provider 协议 |
| `commands/vault.rs` | Vault IPC 和 keygen 阻塞任务切换 | 不实现加密 |
| `audit/model.rs` | 审计记录 DTO | feature model |
| `audit/repository.rs` | Audit SQL、查询与写入 | `Database` 短连接 |
| `group/model.rs` | Group DTO/request | feature model |
| `group/repository.rs` | Group SQL | repository 私有实现 |
| `group/service.rs` | 验证、引用约束和 CRUD use case | concrete facade |
| `snippet/model.rs` | Snippet DTO/request | feature model |
| `snippet/repository.rs` | Snippet SQL | repository 私有实现 |
| `snippet/service.rs` | 验证与 CRUD use case | concrete facade |
| `profile/model.rs` | Profile、proxy、resolved connection DTO；敏感 resolved 数据 zeroize | 无 SQL |
| `profile/connection.rs` | proxy/options 解析和 host-key option 更新 | 不连接 SSH |
| `profile/error.rs` | Profile validation/credential/reference typed errors | feature 私有 |
| `profile/legacy.rs` | 历史 inline credential 幂等回填 | compatibility boundary |
| `profile/repository.rs` | Profile SQL | repository 私有实现 |
| `profile/service.rs` | Profile CRUD、credential resolution、proxy/jump 验证 | 不依赖 Tauri/russh |
| `vault/model.rs` | Vault DTO 和 zeroizing `Credential` | secret model 不实现 `Debug` |
| `vault/crypto.rs` | Go-compatible AES-256-GCM/key file | `CryptoError` typed boundary |
| `vault/error.rs` | credential 编码错误 | feature 私有 |
| `vault/repository.rs` | Vault SQL 与 Profile 引用 SQL | repository 私有实现 |
| `vault/service.rs` | Vault use case、审计、key generation | 唯一 credential 加解密入口 |
| `backup/model.rs` | `.xcbackup` wire model 与 aggregate DTO | secret-bearing payload 无 `Debug` |
| `backup/format.rs` | 格式校验、Argon2id、AES-GCM | 保持 v1/AAD/nonce 格式 |
| `backup/error.rs` | Backup typed errors | feature 私有 |
| `backup/repository.rs` | 跨域导出与单事务导入 | 明确 aggregate repository |
| `backup/service.rs` | export/preview/import/sync version orchestration | 不依赖 Tauri dialog |
| `ssh/error.rs` | transport/protocol/auth typed errors | 第三方错误不越界 |
| `ssh/events.rs` | terminal outbound event port | 合理的 dependency inversion |
| `ssh/transport.rs` | TCP、SOCKS5、HTTP CONNECT、jump、auth、host-key、subsystem/exec | `russh` boundary |
| `ssh/profile_test.rs` | Profile 测试连接 use case | 无 command |
| `ssh/session.rs` | 单 session、PTY、terminal I/O、completion、`SshService` | registry 委托 manager |
| `ssh/session_manager.rs` | session/JoinHandle 注册、查询、移除、cancel-and-join | runtime owner |
| `sftp/error.rs` | backend/transfer/archive typed errors | feature boundary |
| `sftp/events.rs` | SFTP outbound event port | 不依赖 Tauri |
| `sftp/backend.rs` | Local/remote 流式文件操作，remote 持有封装 route | 不暴露 russh handle；路径策略委托 platform adapter |
| `sftp/state.rs` | `SftpService`、session registry、连接和文件 use case | connection task owner |
| `sftp/transfer.rs` | TransferManager、分块上传下载、复制/移动、磁盘 staging 归档 | worker/cancellation owner |
| `sync/model.rs` | settings/provider/version/conflict DTO | secret config zeroize 且无 `Debug` |
| `sync/error.rs` | operation/scheduler typed errors | 映射稳定错误码 |
| `sync/repository.rs` | Sync SQLite persistence | 原 `store.rs` |
| `sync/service.rs` | local version/settings/provider use case 和统一 operation coordinator | 原 `manager.rs` |
| `sync/scheduler.rs` | bounded queue、计划/变更触发、tracked JoinHandle、shutdown | backpressure 显式返回 |
| `sync/cloud.rs` | pull/push/index/conflict/restore orchestration | 受 operation coordinator 保护 |
| `sync/oauth.rs` | OAuth state、URL/callback、token exchange | deep-link 监听在 app adapter |
| `sync/provider.rs` | WebDAV/S3/GDrive/OneDrive HTTP connector | provider body 不直接进入 IPC error |
| `infrastructure/database/connection.rs` | SQLite connection factory、busy timeout、foreign keys | 不含业务 SQL |
| `infrastructure/database/migration.rs` | schema 和幂等兼容 migration | 不依赖 feature |
| `infrastructure/database/error.rs` | `StorageError` | 保留 rusqlite/io source |
| `infrastructure/platform/mod.rs` | 平台模块路由 | 共用 sandbox filesystem；desktop 子模块由 cfg 隔离 |
| `infrastructure/platform/local_files.rs` | process-visible local path、Windows drive、mode 和 home adapter | mobile document URI 的扩展边界 |
| `infrastructure/platform/desktop/paths.rs` | legacy `XControl` 数据目录和 build channel | desktop only |
| `infrastructure/platform/desktop/dialogs.rs` | 系统保存对话框与落盘 | desktop only |
| `infrastructure/platform/desktop/logs.rs` | 测试渠道日志读取/写入/截断 | desktop only |
| `infrastructure/platform/desktop/drag_out.rs` | drag 临时物化与回收 | desktop only |
| `infrastructure/platform/desktop/settings_migration.rs` | Electron settings 一次性迁移 | desktop only |
| `infrastructure/platform/desktop/error.rs` | `PlatformError` | desktop adapter typed error |

每个目录的 `mod.rs` 只声明子模块和选择性重导出。`commands/mod.rs` 是一个例外：Tauri command
宏会生成同名隐藏 handler symbol，command registry 需要 glob 一并导入这些宏符号；其模块本身
仍为 crate-private。

## Tauri Command Boundary

当前 94 个 command 全部位于 `commands/`。它们只处理：

1. `State`、IPC 参数和 binary body/response；
2. 输入的轻量适配；
3. 必要的 `spawn_blocking`；
4. 调用 feature facade；
5. 保持既有 `CommandError` 或 desktop 字符串错误 contract；
6. 成功写操作后的 Sync change 通知。

Feature 中不存在 `#[tauri::command]`。SSH/SFTP 的反向消息也通过 event port 注入，不再持有
`AppHandle`。

## Database Boundary

`Database` 只持有 `Arc<PathBuf>`，每次操作创建短生命周期 connection。没有全局 SQLite
connection mutex，因而不会发生 connection lock 跨 `.await`。连接统一启用：

- `busy_timeout = 5s`；
- `foreign_keys = ON`；
- migration 中保持历史 WAL/schema/column backfill。

业务 SQL 与其领域共同演进。Backup 是唯一合法跨域 repository，因为导入必须在一个 SQLite
transaction 内保持原子性；它不是全局 repository 垃圾桶。

## SSH Runtime Ownership

```text
SshService
├── ProfileService + AuditRepository
├── Arc<dyn SessionEventSink>
└── SessionManager
    ├── sessions: id -> Arc<Session>
    └── tasks: id -> JoinHandle
```

- `Session` 只拥有一个活动连接的命令 channel、host-key decision、输出缓冲和 cancellation；
- `SessionManager` 负责 registry 与 task 生命周期；
- session 自然完成后回收，应用退出执行 cancel、disconnect、join；
- `ConnectedRoute` 的 russh handle 为私有；SFTP 只调用 `open_subsystem`/`exec` 等封装能力；
- SSH channel 使用有界 channel，不在 `.await` 期间持有 `std::sync::MutexGuard`。

## SFTP Runtime Ownership

```text
SftpService
├── session registry
├── tracked connection tasks
├── TransferManager
│   ├── transfer/upload registries
│   ├── Semaphore(5)
│   ├── tracked workers
│   └── CancellationToken
└── Arc<dyn SftpEventSink>
```

上传/下载继续使用最多 1 MiB 的 binary IPC chunk 和 128 KiB relay buffer。目录下载和
remote-to-remote archive 使用有限磁盘 staging，再流式压缩/上传；不会把整棵目录及压缩包同时
驻留内存。shutdown 会取消并等待 connection/transfer workers，清理临时文件。

## Sync Runtime Ownership

`SyncService` 私有持有 repository、BackupService、backup directory、OAuth pending state、
`OperationCoordinator` 与 scheduler slot。Scheduler 使用容量 32 的 bounded channel：手动
reload/sync/push 在队列满或关闭时返回稳定错误，不再虚假返回 `started: true`；change 通知失败
会记录日志。

所有 create/restore/pull/push/conflict/delete-cloud 变更使用同一个 Tokio operation mutex，避免
版本恢复和云端 index read-modify-write 并发。该 mutex 有意覆盖完整异步 operation；它不是
保护普通数据结构的细粒度锁，因此不存在 lock ordering 链。

## Error Strategy

下层边界使用 `StorageError`、`VaultError`/`CryptoError`、`BackupError`、`ProfileError`、
`SshError`、`SftpError`、`SyncError` 和 `PlatformError`。内部不再以裸
`Result<T, String>` 承载 repository、crypto、transport 或 transfer 错误。

Feature facade 使用结构化 `CommandError { code, message, references }` 表示稳定 use-case 错误；
command 可直接让 Tauri 序列化该类型。Desktop 历史 commands 保留 `Result<T, String>`，因为
前端已有字符串错误 contract，转换发生在 `commands/desktop.rs`。第三方 provider response body、
russh debug detail 和敏感 plaintext 不直接暴露到 IPC。

## Credential and Secret Boundary

- 只有 `vault/crypto.rs` 实现 credential AES-256-GCM；Profile、Backup、Sync 复用 `Encryptor`；
- key file、nonce/ciphertext/tag、Backup Argon2id/AAD 均保持 Go 兼容；
- `Credential`、`ResolvedProfileNode`、`SyncSettings`、`SyncProviderConfig`、`BackupPayload` 等
  secret-bearing 类型不实现 `Debug`；
- secret model 使用 `Zeroize`/`ZeroizeOnDrop` 或 `Zeroizing`；
- 对前端返回的 Profile/Vault/Sync metadata 不包含 resolved credential/provider secret；
- 日志和错误不输出密码、私钥、token、明文备份或 provider 响应正文。

## App State and Shutdown

没有全局 God `AppState`。Tauri 分别管理 `GroupService`、`SnippetService`、`ProfileService`、
`VaultService`、`BackupService`、`SyncService`、`SshService`、`SftpService` 和
`AuditRepository`。Command 只能请求其签名中声明的 state。

Desktop `ExitRequested` 的清理顺序为：SSH sessions -> SFTP sessions/transfers -> Sync scheduler
-> shutdown backup。每个长期任务均有 manager/slot 保存其 `JoinHandle`。Mobile composition 使用
相同 feature facade；suspend/resume 与移动 OS 后台网络策略仍属于真机集成阶段。

## Platform Boundary

### Desktop only

- single-instance、dialog、opener、drag、updater、process plugins；
- window controls、ready-to-show、日志查看器、Electron settings migration、drag-out；
- 系统任意路径对话框和 legacy `XControl` 用户目录选择。

以上插件放在 Cargo desktop target dependency table，代码用 `#[cfg(desktop)]`，默认 capability
显式限制为 Linux/macOS/Windows。

## Desktop / Mobile Strategy

```text
                Shared feature core
                       |
            +----------+----------+
            |                     |
     Desktop adapters       Mobile integration
```

移动端复用同一套 Profile、Vault、Backup、SSH/SFTP 和 Sync 业务逻辑。平台差异通过 capability、
Cargo target dependency、composition 分支和 feature port 处理，不复制业务目录。

### Cross-platform core

- Profile/Group/Snippet/Audit/Vault/Backup/Sync 规则与格式；
- bundled SQLite schema/repositories；
- russh SSH 与 remote SFTP；
- cloud providers 与 OAuth use case；
- terminal/SFTP event ports 和 session/transfer ownership。

### Mobile readiness and remaining integration work

| 范围 | Android | iOS |
| --- | --- | --- |
| Tauri entry/composition | `mobile_entry_point` 与 mobile builder 已存在 | 同左 |
| Capability | `mobile.json` 仅 core/app 权限 | 同左 |
| 数据目录 | Tauri app data sandbox | Tauri app data sandbox |
| Credential key | 当前为 sandbox 内加密 key file；可后续接 Keystore adapter | 可后续接 Keychain adapter |
| SSH/SFTP sockets | 需 NDK target/真机验证 russh、ring、DNS、代理 | 需 Xcode target/真机验证 Network policy |
| 本地文件 | 当前 local session 只能访问进程可见路径；后续接 content URI/document picker | 后续接 security-scoped URL/document picker |
| SSH agent | 视为 desktop capability；mobile 应提示不可用或接平台 provider | 同左 |
| 生命周期 | 需补 suspend/resume、后台限时和网络切换策略 | iOS 后台 socket 限制尤其需要真机策略 |
| Server detail | 远端 Linux `/proc`/shell 假设与手机本机无关 | 同左 |

不会复制 `desktop/ssh` 与 `mobile/ssh` 两套业务代码，也不会预先创建无实现的
`android.rs`/`ios.rs`。

## Dependency Compatibility Audit

| 依赖/假设 | 状态 |
| --- | --- |
| `tauri-plugin-single-instance/dialog/opener/drag/updater/process` | desktop target-gated |
| `tauri-plugin-deep-link` | 共用；mobile callback 需真机验证 |
| `rusqlite(bundled)` | 无系统 SQLite 路径假设；需各 target 编译验证 |
| `russh`/`russh-sftp`/`ring` | 不含 desktop API；需 Android/iOS toolchain 验证 |
| `reqwest` + rustls + system-proxy | 无 OpenSSL 依赖；system proxy 行为需 mobile 验证 |
| `dirs` | 只用于 platform adapters 的 legacy path 与 local SFTP home fallback |
| filesystem/temp path | desktop adapter 已隔离；SFTP staging 使用进程 temp sandbox |
| process/shell | 不启动本地业务进程；ServerDetail 命令在远端 SSH 执行 |
| keyring | 当前未依赖；未来 secure storage 通过 platform adapter 引入 |
| updater/drag-out | capability 和代码均 desktop-only，未删除现有功能 |

## Initial Audit Resolution

| 初始风险 | 等级 | 处置 |
| --- | --- | --- |
| 远端目录归档整树载入内存 | P0 | 已改为磁盘 staging + 流式复制/归档 |
| Sync `try_send` 静默丢请求 | P0 | 已返回 busy/stopped typed error |
| Sync restore/push/pull 竞态 | P0 | 已统一 `OperationCoordinator` |
| secret-bearing model `Debug`/clone | P0 | 已移除 Debug，增加 zeroize；保留必要所有权 clone |
| command 与 SQL/SSH/SFTP 流程混合 | P1 | 94 个 command 全部迁至 adapter 层 |
| session/transfer detached tasks | P1 | manager 跟踪、自然回收、cancel-and-join |
| SFTP 泄漏 raw russh handle | P1 | `ConnectedRoute` 私有封装 subsystem/exec |
| feature 直接持有 Tauri AppHandle | P1 | feature-owned event port + app adapter |
| root God files / Go manager 命名 | P1/P2 | feature model/repository/service/manager 按真实职责拆分 |
| SQLite schema 与业务 SQL 混合 | P1/P2 | infrastructure migration 与 feature repository 分离 |
| 大面积 `Result<T, String>` | P1/P2 | typed lower errors；仅 desktop IPC contract 保留字符串 |
| Desktop 依赖进入 mobile graph | P1 | Cargo target gate + 分离 capability/builder |
| Sync async 流程中的短 SQLite 调用 | P2 性能 | 仍需 profiling；若成为瓶颈再引入专用 DB worker，不先造 pool/trait |
| OAuth callback 短任务未集中登记 | P2 生命周期 | 由 Tauri runtime 承载；后续 mobile lifecycle 阶段评估 task set |
| ServerDetail 假设远端 Linux | P2 兼容 | 保持既有行为，未来以 remote OS collector 分支扩展 |

## Migration Record

每一阶段在通过 Rust gate 后独立提交：

| Phase | Commit | 内容 |
| --- | --- | --- |
| 1 | `7f53a8b` | 架构审计与迁移方案 |
| 2 | `ceb8868` | app/commands/database 基础边界 |
| 3 | `08c70fb` | Audit/Group/Snippet feature boundaries |
| 4 | `8b73738` | Profile/Vault boundaries |
| 5a | `41966df` | Backup command adapters |
| 5b | `e77bf5b` | Backup model/format |
| 5c | `ddbd609` | Backup aggregate repository |
| 6-7 | `5aae685` | SSH/SFTP runtime ownership、流式归档、shutdown |
| 8 | `1428c3a` | Sync service/repository/scheduler/coordinator |
| 9-10 | `5e93ea8` | typed errors、desktop platform adapters、mobile capability |
| 11 | `12ea2bf` | Tauri event ports 与 visibility 收口 |
| 12 | `6a26f34` | 本地文件路径与权限语义收敛到 platform adapter |

所有移动均保持 command 名称、JSON 字段、binary IPC、SQLite schema、数据目录、密文与备份格式。

## Verification Policy and Record

每阶段及最终验收使用：

```bash
cd src-tauri
cargo fmt --all -- --check
cargo check --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked

npm --prefix web run test:unit
npm --prefix web run lint
npm --prefix web run build
```

2026-09-09 最终结果：

- Rust `fmt/check/clippy -D warnings/test` 全部通过，60 passed，0 failed；
- Web unit tests 82 passed，lint 通过，production build 通过；
- 重构前后 command 集合均为 94 个，名称集合无差异；
- Android 与 iOS Cargo 一级依赖树均能解析，且不包含 single-instance、dialog、opener、
  drag、updater、process 六个 desktop-only plugins；
- Desktop smoke binary 编译成功，但当前无图形显示环境，Tao 在业务初始化前报告
  `Failed to initialize GTK`；本机也没有 `xvfb-run`；
- 本机仅安装 `x86_64-unknown-linux-gnu` Rust target，因此没有把依赖树解析等同于 Android/iOS
  cross-compile；Windows/macOS/Linux bundle 和移动真机仍由对应平台 CI/机器验证。

## Visibility Rules

1. 默认 private；兄弟子模块共享用 `pub(super)`；composition/commands 需要时才用 `pub(crate)`；
2. `pub` 只用于 crate 真正对外入口；私有 module 内的序列化 DTO 不等于外部 Rust API；
3. repository、error、manager、provider 实现不从 feature `mod.rs` 暴露；
4. `mod.rs` 不承载业务逻辑，只声明模块与最小 re-export；
5. 不创建 `common`、`utils`、`helpers`、`service/impl` 或单实现 trait；
6. `SessionEventSink`/`SftpEventSink` 是因为平台 adapter 和测试替换确有价值而存在的 trait。

## Future Extension Rules

1. 新 feature 按业务能力组织，复杂度增长后再从单文件升级为目录；
2. 新 command 必须位于 `commands/`，不能直接执行 SQL、crypto、russh 或管理 task map；
3. 新业务 SQL 放入所属 feature repository；跨域事务必须声明 aggregate owner；
4. russh、russh-sftp、rusqlite、cloud HTTP 和 OS API 不越过各自边界；
5. 新后台任务必须声明 owner、bounded/backpressure、取消、自然回收与 shutdown；
6. 不在 `.await` 时持有普通互斥锁；长操作串行化只能由明确 operation coordinator 完成；
7. secret 类型默认不实现 `Debug`，避免不必要 clone，并明确 zeroize 生命周期；
8. Desktop/Mobile 共享 core，只为真实平台差异增加 adapter/cfg；
9. 对外 contract 变更必须先设计迁移，不能借架构重构修改 schema/密文/备份/IPC；
10. 每个架构阶段保持可编译、可测试并独立提交。
