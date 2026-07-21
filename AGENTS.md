# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

XControl is a browser-based SSH terminal application. Users manage SSH connections through a web UI powered by xterm.js, with encrypted credential storage, multi-tab sessions, and group-based organization. The UI and documentation are in Chinese.

## Development Commands

### Backend (Go 1.26+) — `server/`

```bash
cd server
go build -o xcontrol-server .                      # Dev build
CGO_ENABLED=0 go build -tags prod -o xcontrol-server .  # Prod build (embeds frontend)
./xcontrol-server                                   # Run (default port 9090)
```

Environment variables: `XCONTROL_PORT` (default 9090), `XCONTROL_DB_PATH` (default `./data/xcontrol.db`), `XCONTROL_KEY_PATH` (default `./data/key`), `XCONTROL_LOG_LEVEL` (info|debug).

### Frontend (React/TypeScript) — `web/`

```bash
cd web
npm install                     # Install dependencies
npm run dev                     # Dev server with HMR (proxies /api and /ws to :9090)
npm run build                   # Type check + production build (tsc -b && vite build)
npm run lint                    # ESLint
npm run preview                 # Preview production build
npx shadcn@latest add <comp>   # Add shadcn/ui components (e.g., button, dialog)
```

### Running Locally

Start the Go backend first (`cd server && ./xcontrol-server`), then the Vite dev server (`cd web && npm run dev`). The frontend proxies API/WebSocket requests to `localhost:9090`.

### Tests

```bash
cd server
go test ./...                                    # Run all Go tests
go test -run TestEnsurePublicKey ./gateway/handler  # Run a single test by name
go test -v ./gateway/handler                     # Verbose, one package

cd web
npm run test:unit                                # Run all Vitest frontend tests (vitest run)
npx vitest run src/lib/completionEngine.test.ts  # Run a single frontend test file
npx vitest                                       # Watch mode
```

Go uses the standard `testing` package (no extra deps). Frontend tests use Vitest (`vitest` devDependency); test files are co-located as `*.test.ts`. Both run without network access or a live database.

## Architecture

Two-process model: Go HTTP server (API + WebSocket + SQLite) and Vite-served React SPA. They communicate over REST and a WebSocket carrying terminal I/O.

### Backend (Go) — `server/`

Entry point (`main.go`) wires: `config.Load()` → slog logger → `store.InitDB` → `crypto.NewEncryptor` → `gateway.NewRouter` → `http.ListenAndServe`. Stores, protocol registry, WebSocket hub, and handlers are all constructed inside `gateway.NewRouter()` (`router.go`), not in `main.go`.

Layered architecture:
- **`config/`** — Env var loader producing server configuration.
- **`store/`** — SQLite persistence via `modernc.org/sqlite` (pure Go, no CGO). Uses `SetMaxOpenConns(1)` to serialize writes. Migrations are idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements; new columns are added via the `addColumnIfMissing` helper (PRAGMA guard + `ALTER TABLE ADD COLUMN`).
- **`model/`** — Data types: `Profile`, `Group`, `Vault`, `Snippet`, `AuditLog`. Both `Profile` and `Group` carry an `icon` field — a stable string key (e.g. `"server"`, `"folder"`) resolved to Lucide icons by the frontend.
- **`crypto/`** — AES-256-GCM encryption for vault credentials; key auto-generated on first run at `./data/key`.
- **`protocol/`** — `Driver` + `Shell` interfaces with `Manager` registry (factory pattern). SSH and SFTP are implemented. This is the extension point for adding new connection types.
- **`connpool/`** — Shared SSH/SFTP connection pool per server.
- **`ws/`** — WebSocket hub (session_id → Conn mapping) and message types (input/output/resize/exit/error/ping/pong). Uses `coder/websocket`. Also includes `SftpHub` for SFTP transfer progress.
- **`gateway/`** — HTTP router (Go 1.22+ enhanced routing), middleware (Recovery → Logger → CORS — no auth middleware yet), and handlers.

**Note:** There is no separate service layer. Business logic lives in `gateway/handler/` handlers. Key handlers: `session.go` manages active sessions (each holding a `protocol.Driver` and `protocol.Shell`); `ws.go` bridges the hub to sessions; `profile.go` handles credential rotation (new vault entry, old one cleaned up when `RefCount` drops to zero); `group.go` refuses to delete non-empty groups (409 `GROUP_NOT_EMPTY`).

Key request flow: `POST /api/sessions` with `{profile_id, cols, rows}` → backend opens SSH connection → frontend opens `WebSocket /ws?session_id=...` → bidirectional terminal I/O.

SFTP flow: `POST /api/sftp/sessions` → `GET /api/sftp/sessions/{id}/list` for directory listing → file operations (upload/download/mkdir/rename/delete) → built-in text editor via `GET/PUT /api/sftp/sessions/{id}/file`.

### Frontend (React) — `web/src/`

- **`api/`** — Fetch wrapper (`client.ts`) and resource-specific modules (profile, group, session, snippet, sftp)
- **`store/`** — Zustand stores: `profile.ts` (connections + groups + search/filter), `session.ts` (terminal tabs + lifecycle), `settings.ts` (theme/fonts, localStorage-persisted)
- **`hooks/`** — `useTerminal.ts` (xterm.js lifecycle), `useWebSocket.ts` (connection, heartbeat, I/O)
- **`lib/`** — Icon registries: `groupIcons.tsx` and `serverIcons.tsx` map stable icon-key strings to Lucide components with fallback resolvers. Add new icons here rather than inlining Lucide imports in components.
- **`components/`** — Layout (resizable sidebar), Sidebar (connection list with search/group filter), ProfileForm (create/edit dialog), Terminal (TabBar + TerminalPane), ConnectionDialog (animated progress), CommandPalette (⌘K search across profiles/snippets/settings), Sftp (file browser with dual-pane layout, Monaco editor, transfer queue), `ui/` (shadcn/ui primitives)
- **`types/`** — TypeScript interfaces mirroring backend models

Path alias: `@` maps to `./src` (configured in `vite.config.ts` and `tsconfig.app.json`).

Frontend builds to `server/web_dist/` (not the default `dist/`), which gets embedded into the Go binary via `//go:embed` when built with `-tags prod`.

### Database

SQLite with 5 auto-migrated tables on startup: `groups` (nested via `parent_id`, with `icon` column), `vault` (encrypted credentials), `profiles` (references `vault` and `groups`, with `icon` column), `snippets`, `audit_logs`. Orphaned vault entries are cleaned up when profiles are deleted or credentials are rotated.

### WebSocket Message Protocol

JSON messages with `type` field: `input`, `output`, `resize`, `exit`, `error`, `ping`, `pong`, `auth`, `metadata`. Binary frames are reserved for future protocol extensions.

## Desktop Packaging (Electron) — `electron/`

The `electron/` directory contains an Electron wrapper for building desktop applications. The Go backend binary embeds the frontend static files via `//go:embed` (production build). Build scripts: `build.sh` (Linux/macOS/Windows), `build.ps1` (Windows). See `electron/README.md` for details.

## UI 设计规范

详见 `DESIGN.md`。核心要点：
- 新组件优先使用 shadcn/ui（`web/src/components/ui/`），用 `npx shadcn@latest add` 添加
- 颜色使用语义 CSS 变量（`--bg`、`--fg`、`--accent` 等），不硬编码色值
- 圆角统一：浮层 `--r-lg`（12px），表单控件 `--r-sm`（6px）
- 类名合并使用 `cn()`（`@/lib/utils`），不手写模板字符串

## Technical Notes

- Go module: `github.com/yuweinfo/xcontrol`
- UI components use shadcn/ui (new-york style, Lucide icons, Tailwind CSS variables)
- Tailwind CSS v4 with CSS-first configuration via `@tailwindcss/vite` plugin and `@theme` directive in `web/src/index.css`
- Test infrastructure exists: Go uses the standard `testing` package (`server/gateway/handler/vault_test.go`); frontend uses Vitest (`npm run test:unit`, co-located `*.test.ts` files). Run both with the commands in the Tests section above.
- SSH host key verification uses `InsecureIgnoreHostKey()` — acceptable for development, not production
- SFTP file editor uses Monaco Editor via `@monaco-editor/loader` and `vite-plugin-monaco-editor`
- Detailed design document: `docs/DEVELOPMENT.md` (in Chinese, includes API specs, data model, and architecture diagrams)
- Keep UI text and documentation language consistent (Chinese) when editing user-facing strings
