package middleware

import (
	"net/http"
	"strings"
)

// mutatingPrefixes are the business-data endpoints whose successful writes
// should trigger the sync auto-backup (debounced). Sync/backup endpoints
// themselves are excluded to avoid recursion.
var mutatingPrefixes = []string{
	"/api/profiles",
	"/api/groups",
	"/api/snippets",
	"/api/vault",
}

// ChangeNotifier reports successful mutating requests on business endpoints
// to the sync manager.
func ChangeNotifier(notify func(), next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isMutatingBusinessCall(r) {
			next.ServeHTTP(w, r)
			return
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if sw.status >= 200 && sw.status < 300 {
			notify()
		}
	})
}

func isMutatingBusinessCall(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
	default:
		return false
	}
	for _, prefix := range mutatingPrefixes {
		if strings.HasPrefix(r.URL.Path, prefix) {
			return true
		}
	}
	return false
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
