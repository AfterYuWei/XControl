package gateway

import (
	"database/sql"
	"net/http"

	"github.com/yuweinfo/sshx/crypto"
	"github.com/yuweinfo/sshx/gateway/handler"
	"github.com/yuweinfo/sshx/gateway/middleware"
	"github.com/yuweinfo/sshx/protocol"
	sshdriver "github.com/yuweinfo/sshx/protocol/ssh"
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

	// Initialize WebSocket hub
	hub := ws.NewHub()

	// Initialize handlers
	profileH := handler.NewProfileHandler(profileStore, vaultStore, encryptor)
	groupH := handler.NewGroupHandler(groupStore)
	snippetH := handler.NewSnippetHandler(snippetStore)
	sessionH := handler.NewSessionHandler(profileStore, vaultStore, auditStore, pm)
	wsH := handler.NewWSHandler(hub, sessionH)

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

	// Apply middleware
	var h http.Handler = mux
	h = middleware.Recovery(h)
	h = middleware.Logger(h)
	h = middleware.CORS(h)

	return h
}
