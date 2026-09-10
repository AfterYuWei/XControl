# Repository Guide

## Project

eizhu is a Tauri 2 desktop SSH terminal and SFTP client. React/TypeScript renders the UI;
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
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

## Architecture

- `src-tauri/src/lib.rs`: application composition, plugins, state registration and shutdown.
- `database.rs`: SQLite migrations and connection policy.
- `credential_crypto.rs`: AES-256-GCM credential compatibility.
- `profiles.rs`, `vault.rs`, `groups.rs`, `snippets.rs`, `audit.rs`: local domains.
- `backup.rs`, `sync/`: backup, providers, OAuth and scheduler.
- `ssh/transport.rs`: direct, SOCKS5, HTTP CONNECT and SSH jump connections.
- `ssh/session.rs`: PTY, terminal I/O, completion and host-key confirmation.
- `sftp/`: sessions, file operations, editor, transfers and drag-out materialization.
- `server_detail.rs`: host information and resource metrics through SSH exec.
- `web/src/api/`: fine-grained Tauri command wrappers.
- `web/src/store/`: Zustand state.

React communicates with Rust through Tauri commands and events. Upload/download payloads use
binary Tauri IPC. There is no local HTTP or WebSocket gateway.

## Data and compatibility

Data stays in the `eizhu` user-data directory. The SQLite schema, key file and encrypted
credential representation remain stable. XControl backup imports stay backward compatible. Sensitive resolved
credentials are zeroized on drop. Host keys use SHA-256 fingerprints and changed keys require
explicit confirmation.

## UI conventions

Follow `DESIGN.md`: prefer shadcn/ui, semantic CSS variables, shared radius tokens and `cn()`.
Add server/group icons through their registries instead of inline imports. Keep Chinese UI wording
consistent.
