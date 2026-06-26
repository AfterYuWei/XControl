# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## Project Overview

XControl is a browser-based SSH terminal application. Users manage SSH connections through a web UI powered by xterm.js, with encrypted credential storage, multi-tab sessions, and group-based organization. The UI and documentation are in Chinese.

## Development Commands

### Backend (Go 1.26+) — `server/`

```bash
cd server
go build -o xcontrol-server .      # Build binary
./xcontrol-server                   # Run (default port 9090)
```

Environment variables: `XCONTROL_PORT`, `XCONTROL_DB_PATH`, `XCONTROL_KEY_PATH`, `XCONTROL_LOG_LEVEL` (info|debug). The SQLite database and auto-generated AES key are stored under `server/data/` by default.

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

The Vite dev server listens on `0.0.0.0` and proxies `/api` and `/ws` to `localhost:9090`. The path alias `@` maps to `./src`.

### Running Locally

Start the Go backend first (`cd server && ./xcontrol-server`), then the Vite dev server (`cd web && npm run dev`). Open the URL printed by Vite; API and WebSocket requests are proxied to the backend.

### Tests

No test infrastructure exists yet. There are no Go test files or frontend test runners. Add tests with `go test` or a Vite-compatible test runner (e.g., Vitest) before enabling test commands.

## Architecture

XControl uses a two-process model: a Go HTTP/WebSocket server that persists state and opens SSH connections, and a Vite-served React SPA that renders the terminal UI. They communicate over REST and a WebSocket carrying terminal I/O.

### Backend (Go) — `server/`

The backend is organized into layers that mirror the architecture described in `docs/DEVELOPMENT.md`:

- **Entry point** (`main.go`) wires `config.Load()` → slog logger → `store.InitDB` → `crypto.NewEncryptor` → `gateway.NewRouter` → `http.ListenAndServe`. The stores, protocol registry, WebSocket hub, and handlers are all constructed inside `gateway.NewRouter()` (`router.go`), not in `main.go`.
- **config/** (`config.go`) loads environment variables and produces the server configuration.
- **store/** provides SQLite-backed persistence via `modernc.org/sqlite` (pure Go, no CGO). It includes stores for profiles, groups, vault credentials, snippets, and audit logs, plus `sqlite.go` for schema initialization and migrations.
- **crypto/** (`aes.go`) implements AES-256-GCM encryption. The key is generated automatically on first run at the configured key path (`server/data/key` by default).
- **model/** defines the core data types: `Profile`, `Group`, `Vault`, `Snippet`, and `AuditLog`. Both `Profile` and `Group` carry an `icon` field — a stable string key (e.g. `"server"`, `"folder"`) that the frontend resolves to a Lucide line icon; legacy emoji values fall back to the default.
- **protocol/** defines the `Driver` and `Shell` interfaces and a `Manager` registry (constructed via `protocol.NewManager()`). This is the main extension point for adding new connection types. Only `protocol/ssh/` is implemented today; the SSH driver also supports jump-host (`ProxyJump`) connections.
- **ws/** provides the WebSocket hub and connection wrapper (both in `hub.go`) plus message types (`message.go`). It maps a `session_id` to a single WebSocket connection and forwards bidirectional traffic between the browser and the SSH shell. Uses `coder/websocket` (not gorilla or `net/websocket`).
- **gateway/handler/** holds the business logic — there is **no separate `service/` layer**. Handlers: `profile.go`, `group.go`, `snippet.go`, `session.go`, `ws.go`, plus `common.go` for JSON helpers. `SessionHandler` (`session.go`) manages the lifecycle of active sessions (each holding a `protocol.Driver` and `protocol.Shell`); `WSHandler` bridges the hub to sessions. Credential rotation in `ProfileHandler.Update` stores a new vault entry and deletes the old one only when its `RefCount` drops to zero (same orphan-cleanup logic used on delete). `GroupHandler.Delete` refuses to delete a non-empty group (409 `GROUP_NOT_EMPTY`) via `ProfileStore.CountByGroup`, so servers must be moved/removed first.
- **gateway/** contains the HTTP router (`router.go`) and middleware. Routing uses Go 1.22+ enhanced patterns (`GET /api/profiles`, etc.). Only three middleware exist, applied in order `Recovery → Logger → CORS` — there is no auth middleware yet.

The typical SSH session flow is:

1. Frontend `POST /api/sessions` with `{profile_id, cols, rows}`.
2. `SessionHandler` creates a session, opens the profile via the protocol `Manager`, and asks the SSH driver to authenticate and request a PTY shell.
3. Backend returns a `session_id`.
4. Frontend opens `WebSocket /ws?session_id=...`.
5. The WebSocket hub bridges the browser and the SSH shell: terminal input flows `WebSocket → Shell.Write`, and output flows `Shell.Read → WebSocket`.

### Frontend (React) — `web/src/`

The frontend is built on React 19, TypeScript, Vite, Tailwind CSS v4, and shadcn/ui. State and side effects are split by concern:

- **api/** wraps `fetch` (`client.ts`) and provides resource-specific modules for profiles, groups, sessions, and snippets.
- **store/** uses Zustand: `profile.ts` manages connection profiles, group tree, and search/filter; `session.ts` manages terminal tabs and their lifecycle; `settings.ts` persists UI preferences (theme, fonts) to `localStorage`.
- **hooks/** encapsulates reusable behavior: `useTerminal.ts` manages an xterm.js instance and its lifecycle, and `useWebSocket.ts` handles connection, heartbeat, and I/O. Session creation/teardown is coordinated within `store/session.ts` and the `App`/`Terminal` components.
- **lib/** holds the icon registries: `groupIcons.tsx` and `serverIcons.tsx` map stable icon-key strings (stored on `Group`/`Profile`) to Lucide components and expose `resolveGroupIcon`/`resolveServerIcon` fallback resolvers (`DEFAULT_GROUP_ICON` = `folder`, `DEFAULT_SERVER_ICON` = `server`). Add new icons here rather than inlining Lucide imports in components.
- **components/** contains business components organized by feature (Layout, Sidebar with group tree and `GroupForm` for creating/editing groups with icon picker, Terminal with tab bar and panes, ProfileForm, ConnectionDialog with animated connection progress, CommandPalette for ⌘K search, ServerPanel, StatusBar, ThemeToggle, Toast) and `components/ui/` holds shadcn/ui primitives.
- **types/** mirrors backend models with TypeScript interfaces.

The main UI is a resizable panel group: a collapsible sidebar on the left for connection management and a main terminal area on the right with a tab bar and terminal panes. The Command Palette (`⌘K`) provides quick search across profiles, snippets, and settings.

### Database

SQLite auto-migrates on startup (`store/sqlite.go`). The connection uses `SetMaxOpenConns(1)` to serialize writes. Migrations are idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements; new columns are added via the `addColumnIfMissing` helper (PRAGMA-based guard then `ALTER TABLE … ADD COLUMN`), so the migration list is safe to re-run and is the place to add additive schema changes. Tables include `groups` (nested via `parent_id`, with an `icon` column), `vault` (encrypted credentials), `profiles` (reference `vault` and `groups`, with an `icon` column added by migration), `snippets`, and `audit_logs`. Credentials are stored in `vault` so that profiles only keep a `vault_id`; orphaned vault entries are cleaned up when profiles are deleted or when their credentials are rotated on update.

### WebSocket Message Protocol

JSON messages carry a `type` field. Common types are `input`, `output`, `resize`, `exit`, `error`, `ping`, `pong`, `auth`, and `metadata`. Binary frames are reserved for future protocol extensions (e.g., SFTP). Messages are routed through the WebSocket hub and mapped to the corresponding `Shell` method.

## Technical Notes

- Go module: `github.com/yuweinfo/xcontrol`.
- Tailwind CSS v4 is configured CSS-first in `web/src/index.css` using `@theme` and the `@tailwindcss/vite` plugin.
- UI text and `docs/DEVELOPMENT.md` are in Chinese; keep the language consistent when editing user-facing strings.
- SSH host key verification currently uses `InsecureIgnoreHostKey()` — acceptable for development, not production.
- Detailed design document (Chinese, includes API specs, data model, and architecture diagrams): `docs/DEVELOPMENT.md`.
