package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAccessTokenDisabledForWebDebug(t *testing.T) {
	rec := httptest.NewRecorder()
	AccessToken("", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/groups", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestAccessTokenAcceptsCookieAndBearer(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	for _, setup := range []func(*http.Request){
		func(r *http.Request) { r.AddCookie(&http.Cookie{Name: accessTokenCookie, Value: "secret"}) },
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer secret") },
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/groups", nil)
		setup(req)
		rec := httptest.NewRecorder()
		AccessToken("secret", next).ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d", rec.Code)
		}
	}
}

func TestAccessTokenRejectsInvalidToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/api/vault/1", nil)
	req.AddCookie(&http.Cookie{Name: accessTokenCookie, Value: "wrong"})
	rec := httptest.NewRecorder()
	AccessToken("secret", http.NotFoundHandler()).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAccessTokenAcceptsQueryToken(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	// 桌面端 WebSocket 鉴权：session_id 与 access_token 均走 query 参数
	req := httptest.NewRequest(http.MethodGet, "/ws?session_id=s1&access_token=secret", nil)
	rec := httptest.NewRecorder()
	AccessToken("secret", next).ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}

	// 错误的 query token 必须被拒绝
	req = httptest.NewRequest(http.MethodGet, "/ws?session_id=s1&access_token=wrong", nil)
	rec = httptest.NewRecorder()
	AccessToken("secret", next).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("invalid query token status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAccessTokenQueryDoesNotOverrideBearer(t *testing.T) {
	// 优先级验证：Bearer 头存在（即使错误）时不回退到 query 参数
	req := httptest.NewRequest(http.MethodGet, "/ws?access_token=secret", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	AccessToken("secret", http.NotFoundHandler()).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAccessTokenAllowsHealthAndOAuthCallback(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	for _, target := range []string{
		"/api/health",
		"/api/sync/oauth/gdrive/callback?code=x&state=y",
	} {
		rec := httptest.NewRecorder()
		AccessToken("secret", next).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%s status = %d", target, rec.Code)
		}
	}
}
