package gateway

import (
	"database/sql"
	"io/fs"
	"net/http"
	"strings"

	"github.com/yuweinfo/xcontrol/connpool"
	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/gateway/handler"
	"github.com/yuweinfo/xcontrol/gateway/middleware"
	"github.com/yuweinfo/xcontrol/protocol"
	sftpdriver "github.com/yuweinfo/xcontrol/protocol/sftp"
	sshdriver "github.com/yuweinfo/xcontrol/protocol/ssh"
	"github.com/yuweinfo/xcontrol/store"
	"github.com/yuweinfo/xcontrol/ws"
)

func NewRouter(db *sql.DB, encryptor *crypto.Encryptor, webFS fs.FS) http.Handler {
	mux := http.NewServeMux()

	if err := store.BackfillProfileInlineCredentials(db, encryptor); err != nil {
		panic(err)
	}

	// Initialize stores
	profileStore := store.NewProfileStore(db)
	groupStore := store.NewGroupStore(db)
	vaultStore := store.NewVaultStore(db, encryptor)
	snippetStore := store.NewSnippetStore(db)
	auditStore := store.NewAuditStore(db)

	// Initialize protocol manager
	pm := protocol.NewManager()
	pm.Register("ssh", func(opts protocol.DriverOpts) (protocol.Driver, error) {
		return sshdriver.NewDriver(opts)
	})
	pm.Register("sftp", func(opts protocol.DriverOpts) (protocol.Driver, error) {
		return sftpdriver.NewDriver(opts)
	})

	// Initialize WebSocket hubs
	hub := ws.NewHub()
	sftpHub := ws.NewSftpHub()

	// Initialize connection pool (shared SSH/SFTP connections per server)
	pool := connpool.Init(pm)

	// Initialize handlers
	profileH := handler.NewProfileHandler(profileStore, vaultStore, encryptor)
	groupH := handler.NewGroupHandler(groupStore, profileStore)
	snippetH := handler.NewSnippetHandler(snippetStore)
	vaultH := handler.NewVaultHandler(vaultStore, auditStore)
	sessionH := handler.NewSessionHandler(profileStore, vaultStore, encryptor, auditStore, pm)
	wsH := handler.NewWSHandler(hub, sessionH)
	transferMgr := handler.NewTransferManager(sftpHub)
	sftpH := handler.NewSftpHandler(profileStore, vaultStore, encryptor, auditStore, pm, sftpHub, transferMgr, pool)
	serverDetailH := handler.NewServerDetailHandler(profileStore, vaultStore, encryptor, pool)
	editH := handler.NewEditHandler(sftpH, serverDetailH)

	// Profile routes
	mux.HandleFunc("GET /api/profiles", profileH.List)
	mux.HandleFunc("GET /api/profiles/{id}", profileH.Get)
	mux.HandleFunc("POST /api/profiles", profileH.Create)
	mux.HandleFunc("PUT /api/profiles/{id}", profileH.Update)
	mux.HandleFunc("DELETE /api/profiles/{id}", profileH.Delete)

	// Group routes
	mux.HandleFunc("GET /api/groups", groupH.List)
	mux.HandleFunc("POST /api/groups", groupH.Create)
	mux.HandleFunc("PUT /api/groups/{id}", groupH.Update)
	mux.HandleFunc("DELETE /api/groups/{id}", groupH.Delete)

	// Snippet routes
	mux.HandleFunc("GET /api/snippets", snippetH.List)
	mux.HandleFunc("POST /api/snippets", snippetH.Create)
	mux.HandleFunc("PUT /api/snippets/{id}", snippetH.Update)
	mux.HandleFunc("DELETE /api/snippets/{id}", snippetH.Delete)

	// Vault routes (key/credential management)
	mux.HandleFunc("GET /api/vault", vaultH.List)
	mux.HandleFunc("POST /api/vault", vaultH.Create)
	mux.HandleFunc("POST /api/vault/generate", vaultH.GenerateKeyPair)
	mux.HandleFunc("GET /api/vault/{id}", vaultH.Get)
	mux.HandleFunc("PUT /api/vault/{id}", vaultH.Update)
	mux.HandleFunc("DELETE /api/vault/{id}", vaultH.Delete)
	mux.HandleFunc("GET /api/vault/{id}/references", vaultH.References)
	mux.HandleFunc("GET /api/vault/{id}/reveal", vaultH.Reveal)

	// Session routes
	mux.HandleFunc("POST /api/sessions", sessionH.Create)
	mux.HandleFunc("GET /api/sessions", sessionH.List)
	mux.HandleFunc("DELETE /api/sessions/{id}", sessionH.Close)

	// WebSocket
	mux.HandleFunc("GET /ws", wsH.Handle)

	// SFTP session routes
	mux.HandleFunc("POST /api/sftp/sessions", sftpH.CreateSession)
	mux.HandleFunc("GET /api/sftp/sessions", sftpH.ListSessions)
	mux.HandleFunc("GET /api/sftp/sessions/{id}", sftpH.GetSession)
	mux.HandleFunc("DELETE /api/sftp/sessions/{id}", sftpH.CloseSession)

	// SFTP file operations
	mux.HandleFunc("GET /api/sftp/sessions/{id}/list", sftpH.List)
	mux.HandleFunc("GET /api/sftp/sessions/{id}/stat", sftpH.Stat)
	mux.HandleFunc("GET /api/sftp/sessions/{id}/tree", sftpH.Tree)
	mux.HandleFunc("POST /api/sftp/sessions/{id}/mkdir", sftpH.Mkdir)
	mux.HandleFunc("POST /api/sftp/sessions/{id}/rename", sftpH.Rename)
	mux.HandleFunc("POST /api/sftp/sessions/{id}/delete", sftpH.Delete)

	// SFTP built-in editor (text file read/write with size, binary, and
	// encoding guards + optimistic-lock via mod_time).
	// Note: These routes are kept for backward compatibility. The preferred
	// API is /api/edit/sessions/{id}/file which works for both SFTP and
	// ServerDetail sessions.
	mux.HandleFunc("GET /api/sftp/sessions/{id}/file", sftpH.ReadFile)
	mux.HandleFunc("PUT /api/sftp/sessions/{id}/file", sftpH.WriteFile)

	// Unified file editor routes (works for both SFTP and ServerDetail sessions)
	mux.HandleFunc("GET /api/edit/sessions/{id}/file", editH.ReadFile)
	mux.HandleFunc("PUT /api/edit/sessions/{id}/file", editH.WriteFile)

	// SFTP transfers
	mux.HandleFunc("POST /api/sftp/sessions/{id}/upload", sftpH.Upload)
	mux.HandleFunc("POST /api/sftp/sessions/{id}/download", sftpH.Download)
	mux.HandleFunc("POST /api/sftp/transfer", sftpH.CrossSessionTransfer)
	mux.HandleFunc("GET /api/sftp/transfers", sftpH.ListTransfers)
	mux.HandleFunc("DELETE /api/sftp/transfers", sftpH.ClearCompletedTransfers)
	mux.HandleFunc("DELETE /api/sftp/transfers/{task_id}", sftpH.CancelTransfer)
	mux.HandleFunc("GET /api/sftp/transfers/{task_id}/file", sftpH.ServeDownloadFile)

	// SFTP WebSocket (independent path for transfer progress)
	mux.HandleFunc("GET /api/sftp/ws", sftpH.HandleWS)

	// Server detail (management connection for file browsing + metrics)
	mux.HandleFunc("POST /api/server/sessions", serverDetailH.CreateSession)
	mux.HandleFunc("DELETE /api/server/sessions/{id}", serverDetailH.CloseSession)
	mux.HandleFunc("GET /api/server/sessions/{id}/info", serverDetailH.GetInfo)
	mux.HandleFunc("GET /api/server/sessions/{id}/files", serverDetailH.ListFiles)
	mux.HandleFunc("POST /api/server/sessions/{id}/mkdir", serverDetailH.Mkdir)
	mux.HandleFunc("POST /api/server/sessions/{id}/rename", serverDetailH.Rename)
	mux.HandleFunc("POST /api/server/sessions/{id}/delete", serverDetailH.Delete)
	mux.HandleFunc("GET /api/server/ws", serverDetailH.HandleWS)

	// 静态前端资源：仅当传入 embed 的文件系统时注册（桌面打包模式）。
	// 开发模式下 webFS 为 nil，前端由 Vite dev server 提供。
	if webFS != nil {
		fileServer := http.FileServer(http.FS(webFS))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			rel := strings.TrimPrefix(r.URL.Path, "/")
			if rel == "" {
				rel = "index.html"
			}
			// 找不到对应静态文件时回退到 index.html，支持前端 SPA 路由
			if _, err := fs.Stat(webFS, rel); err != nil {
				r2 := r.Clone(r.Context())
				r2.URL.Path = "/"
				fileServer.ServeHTTP(w, r2)
				return
			}
			fileServer.ServeHTTP(w, r)
		})
	}

	// Apply middleware
	var h http.Handler = mux
	h = middleware.Recovery(h)
	h = middleware.Logger(h)
	h = middleware.CORS(h)

	return h
}
