# Repository Guide

## Project

XControl is a Tauri 2 SSH terminal and SFTP client with desktop support and a shared mobile-ready
Rust core. React/TypeScript renders the UI;
all persistence, encryption, SSH/SFTP, backup and sync logic runs in the Rust process. User-facing
UI and documentation are written in Chinese.

## Commands

```bash
npm ci
npm --prefix web ci
npm run desktop:dev
npm run desktop:build
npm run desktop:smoke

npm --prefix web run test:unit
npm --prefix web run lint
npm --prefix web run build

cd src-tauri
cargo fmt --all -- --check
cargo check --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked
```

## Architecture

- `src-tauri/src/app/`: application composition, Tauri event adapters, plugins and shutdown.
- `src-tauri/src/commands/`: all Tauri IPC command adapters; commands do not own business logic.
- `src-tauri/src/infrastructure/database/`: SQLite connection policy and compatible migrations.
- `src-tauri/src/profile/`, `vault/`, `group/`, `snippet/`, `audit/`: local feature modules and
  domain-owned repositories.
- `src-tauri/src/backup/`, `sync/`: backup aggregate, providers, OAuth and tracked scheduler.
- `ssh/transport.rs`: direct, SOCKS5, HTTP CONNECT and SSH jump connections.
- `ssh/session.rs` + `session_manager.rs`: PTY, terminal I/O and tracked session ownership.
- `sftp/`: sessions, file operations, editor and tracked transfers.
- `infrastructure/platform/desktop/`: dialogs, logs, drag-out, legacy paths and settings migration.
- `server_detail.rs`: host information and resource metrics through SSH exec.
- `web/src/api/`: fine-grained Tauri command wrappers.
- `web/src/store/`: Zustand state.

React communicates with Rust through Tauri commands and events. Upload/download payloads use
binary Tauri IPC. There is no local HTTP or WebSocket gateway.
See `docs/RUST_ARCHITECTURE.md` for dependency, visibility and Desktop/Mobile boundary rules.

## Data and compatibility

Data stays in the legacy `XControl` user-data directory. The SQLite schema, key file, encrypted
credential representation and backup format must remain backward compatible. Sensitive resolved
credentials are zeroized on drop. Host keys use SHA-256 fingerprints and changed keys require
explicit confirmation.

## UI conventions

Follow `DESIGN.md`: prefer shadcn/ui, semantic CSS variables, shared radius tokens and `cn()`.
Add server/group icons through their registries instead of inline imports. Keep Chinese UI wording
consistent.
