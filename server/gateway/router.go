package gateway

import (
	"database/sql"
	"net/http"

	"github.com/yuweinfo/sshx/crypto"
	"github.com/yuweinfo/sshx/gateway/handler"
	"github.com/yuweinfo/sshx/gateway/middleware"
	"github.com/yuweinfo/sshx/protocol"
	sshdriver "github.com/yuweinfo/sshx/protocol/ssh"
	sftpdriver "github.com/yuweinfo/sshx/protocol/sftp"
	"github.com/yuweinfo/sshx/store"
	"github.com/yuweinfo/sshx/ws"
)

func NewRouter(db *sql.DB, encryptor *crypto.Encryptor) http.Handler {
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

	// Initialize handlers
	profileH := handler.NewProfileHandler(profileStore, vaultStore, encryptor)
	groupH := handler.NewGroupHandler(groupStore, profileStore)
	snippetH := handler.NewSnippetHandler(snippetStore)
	sessionH := handler.NewSessionHandler(profileStore, vaultStore, auditStore, pm)
	wsH := handler.NewWSHandler(hub, sessionH)
	transferMgr := handler.NewTransferManager(sftpHub)
	sftpH := handler.NewSftpHandler(profileStore, vaultStore, auditStore, pm, sftpHub, transferMgr)

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

	// SFTP transfers
	mux.HandleFunc("POST /api/sftp/sessions/{id}/upload", sftpH.Upload)
	mux.HandleFunc("POST /api/sftp/sessions/{id}/download", sftpH.Download)
	mux.HandleFunc("GET /api/sftp/transfers", sftpH.ListTransfers)
	mux.HandleFunc("DELETE /api/sftp/transfers", sftpH.ClearCompletedTransfers)
	mux.HandleFunc("DELETE /api/sftp/transfers/{task_id}", sftpH.CancelTransfer)
	mux.HandleFunc("GET /api/sftp/transfers/{task_id}/file", sftpH.ServeDownloadFile)

	// SFTP WebSocket (independent path for transfer progress)
	mux.HandleFunc("GET /api/sftp/ws", sftpH.HandleWS)

	// Apply middleware
	var h http.Handler = mux
	h = middleware.Recovery(h)
	h = middleware.Logger(h)
	h = middleware.CORS(h)

	return h
}
