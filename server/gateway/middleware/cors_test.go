package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSAllowsSameOrigin(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:9090/api/groups", nil)
	req.Header.Set("Origin", "http://127.0.0.1:9090")
	rec := httptest.NewRecorder()

	CORS(nil, next).ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:9090" {
		t.Fatalf("allow origin = %q", got)
	}
}

func TestCORSAllowsConfiguredDebugOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:9090/api/groups", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()

	CORS([]string{"http://localhost:5173"}, http.NotFoundHandler()).ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestCORSRejectsUnknownOrigin(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	})
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:9090/api/sessions", nil)
	req.Header.Set("Origin", "https://attacker.example")
	rec := httptest.NewRecorder()

	CORS(nil, next).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if called {
		t.Fatal("next handler was called")
	}
}
