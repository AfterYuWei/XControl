package gateway

import (
	"database/sql"
	"io/fs"
	"net/http"
	"strings"

	"github.com/yuweinfo/sshx/connpool"
	"github.com/yuweinfo/sshx/crypto"
	"github.com/yuweinfo/sshx/gateway/handler"
	"github.com/yuweinfo/sshx/gateway/middleware"
	"github.com/yuweinfo/sshx/protocol"
	sshdriver "github.com/yuweinfo/sshx/protocol/ssh"
	sftpdriver "github.com/yuweinfo/sshx/protocol/sftp"
	"github.com/yuweinfo/sshx/store"
	"github.com/yuweinfo/sshx/ws"
)

func NewRouter(db *sql.DB, encryptor *crypto.Encryptor, webFS fs.FS) http.Handler {
	mux := http.NewServeMux()

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
	sessionH := handler.NewSessionHandler(profileStore, vaultStore, auditStore, pm)
	wsH := handler.NewWSHandler(hub, sessionH)
	transferMgr := handler.NewTransferManager(sftpHub)
	sftpH := handler.NewSftpHandler(profileStore, vaultStore, auditStore, pm, sftpHub, transferMgr, pool)
	serverDetailH := handler.NewServerDetailHandler(profileStore, vaultStore, pool)

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
	mux.HandleFunc("GET /api/sftp/sessions/{id}/file", sftpH.ReadFile)
	mux.HandleFunc("PUT /api/sftp/sessions/{id}/file", sftpH.WriteFile)

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
