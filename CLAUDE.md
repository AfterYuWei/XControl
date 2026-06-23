# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SSHX is a browser-based SSH terminal application. Users manage SSH connections through a web UI powered by xterm.js, with encrypted credential storage, multi-tab sessions, and group-based organization. The UI and documentation are in Chinese.

## Development Commands

### Backend (Go 1.26+) — `server/`

```bash
cd server
go build -o sshx-server .      # Build
./sshx-server                   # Run (default port 9090)
```

Environment variables: `SSHX_PORT`, `SSHX_DB_PATH`, `SSHX_KEY_PATH`, `SSHX_LOG_LEVEL` (info|debug).

### Frontend (React/TypeScript) — `web/`

```bash
cd web
npm install                     # Install dependencies
npm run dev                     # Dev server with HMR (proxies /api and /ws to :9090)
npm run build                   # Type check + production build (tsc -b && vite build)
npm run lint                    # ESLint
npm run preview                 # Preview production build
```

### Running Locally

Start the Go backend first (`cd server && ./sshx-server`), then the Vite dev server (`cd web && npm run dev`). The frontend proxies API/WebSocket requests to `localhost:9090`.

## Architecture

Two-process model: Go HTTP server (API + WebSocket + SQLite) and Vite-served React SPA.

### Backend (Go) — `server/`

Layered architecture:
- **`main.go`** → **`config/`** (env vars) → **`store/`** (SQLite persistence via modernc.org/sqlite, pure Go, no CGO)
- **`model/`** — Data types: Profile, Group, Vault, Snippet, AuditLog
- **`crypto/`** — AES-256-GCM encryption for vault credentials; key auto-generated on first run at `./data/key`
- **`protocol/`** — `Driver` + `Shell` interfaces with factory registry (`ProtocolManager`). Currently only `ssh/` is implemented. This is the extension point for adding new protocols.
- **`ws/`** — WebSocket hub (session_id → Conn mapping) and message types (input/output/resize/exit/error/ping/pong)
- **`gateway/`** — HTTP router (Go 1.22+ enhanced routing), middleware (CORS, logger, recovery), and handlers

Key request flow: `POST /api/sessions` with profile_id → backend opens SSH connection → frontend opens `WebSocket /ws?session_id=...` → bidirectional terminal I/O.

### Frontend (React) — `web/src/`

- **`api/`** — Fetch wrapper (`client.ts`) and resource-specific modules (profile, group, session, snippet)
- **`store/`** — Zustand stores: `profile.ts` (connections + groups + search/filter), `session.ts` (terminal tabs + lifecycle), `settings.ts` (theme/fonts, localStorage-persisted)
- **`hooks/`** — `useTerminal.ts` (xterm.js lifecycle), `useWebSocket.ts` (connection, heartbeat, I/O)
- **`components/`** — Layout (resizable sidebar), Sidebar (connection list with search/group filter), ProfileForm (create/edit dialog), Terminal (TabBar + TerminalPane), ConnectionDialog (animated progress), `ui/` (shadcn/ui primitives)
- **`types/`** — TypeScript interfaces mirroring backend models

Path alias: `@` maps to `./src` (configured in `vite.config.ts`).

### Database

SQLite with 5 auto-migrated tables on startup: `groups`, `vault` (encrypted credentials), `profiles` (references vault), `snippets`, `audit_logs`.

### WebSocket Message Protocol

JSON messages with `type` field: `input`, `output`, `resize`, `exit`, `error`, `ping`, `pong`, `auth`, `metadata`.

## Technical Notes

- Go module: `github.com/yuweinfo/sshx`
- UI components use shadcn/ui (new-york style, Lucide icons, Tailwind CSS variables)
- Tailwind CSS v4 with CSS-first configuration via `@tailwindcss/vite` plugin and `@theme` directive in `web/src/index.css`
- No test infrastructure exists yet (no Go test files, no frontend test runner)
- SSH host key verification uses `InsecureIgnoreHostKey()` — acceptable for development, not production
- Detailed design document: `docs/DEVELOPMENT.md` (in Chinese, includes API specs, data model, and architecture diagrams)
