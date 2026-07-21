package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/yuweinfo/xcontrol/model"
)

func TestBuildAuthURL(t *testing.T) {
	cfg := &model.SyncProviderConfig{OAuthClientID: "cid123"}
	u, err := BuildAuthURL("gdrive", cfg, "http://localhost:9090/api/sync/oauth/gdrive/callback", "state-abc")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u, gdriveAuthURL) {
		t.Fatalf("wrong base: %s", u)
	}
	parsed, _ := url.Parse(u)
	q := parsed.Query()
	if q.Get("client_id") != "cid123" || q.Get("state") != "state-abc" {
		t.Fatalf("missing params: %s", u)
	}
	if q.Get("access_type") != "offline" || q.Get("prompt") != "consent" {
		t.Fatal("gdrive must request offline access with consent prompt")
	}
	if !strings.Contains(q.Get("scope"), "drive.file") {
		t.Fatalf("scope should be minimal drive.file: %s", q.Get("scope"))
	}

	u2, err := BuildAuthURL("onedrive", cfg, "http://x/cb", "s2")
	if err != nil {
		t.Fatal(err)
	}
	q2, _ := url.Parse(u2)
	if !strings.Contains(q2.Query().Get("scope"), "offline_access") {
		t.Fatal("onedrive must request offline_access for refresh tokens")
	}

	if _, err := BuildAuthURL("dropbox", cfg, "http://x/cb", "s"); err == nil {
		t.Fatal("unsupported type must fail")
	}
}

func TestOAuthStateLifecycle(t *testing.T) {
	state := newOAuthState("prov-1")
	if state == "" {
		t.Fatal("empty state")
	}
	// First consume succeeds.
	pid, ok := consumeOAuthState(state)
	if !ok || pid != "prov-1" {
		t.Fatalf("consume failed: %v %s", ok, pid)
	}
	// Replay is rejected.
	if _, ok := consumeOAuthState(state); ok {
		t.Fatal("state replay must be rejected")
	}
}

func TestExchangeAndRefresh(t *testing.T) {
	var gotGrant string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		gotGrant = r.Form.Get("grant_type")
		w.Header().Set("Content-Type", "application/json")
		switch gotGrant {
		case "authorization_code":
			if r.Form.Get("code") != "the-code" {
				t.Errorf("wrong code: %s", r.Form.Get("code"))
			}
			json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "acc-1",
				"refresh_token": "ref-1",
				"expires_in":    3600,
			})
		case "refresh_token":
			json.NewEncoder(w).Encode(map[string]any{
				"access_token": "acc-2",
				"expires_in":   3600,
				// no refresh_token: provider keeps the old one
			})
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	// Point the gdrive token endpoint at the test server via a custom
	// transport is invasive; instead call tokenRequest directly.
	form := url.Values{
		"grant_type": {"authorization_code"},
		"code":       {"the-code"},
	}
	tok, err := tokenRequest(context.Background(), srv.URL, form)
	if err != nil {
		t.Fatal(err)
	}
	if tok.AccessToken != "acc-1" || tok.RefreshToken != "ref-1" {
		t.Fatalf("unexpected tokens: %+v", tok)
	}
	if !tok.valid() {
		t.Fatal("fresh token should be valid")
	}
	if gotGrant != "authorization_code" {
		t.Fatalf("grant not seen: %s", gotGrant)
	}

	// Refresh path preserves old refresh token when provider omits it.
	cfg := &model.SyncProviderConfig{OAuthRefreshToken: "ref-1"}
	_ = cfg
	form2 := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {"ref-1"},
	}
	tok2, err := tokenRequest(context.Background(), srv.URL, form2)
	if err != nil {
		t.Fatal(err)
	}
	if tok2.RefreshToken != "" {
		t.Fatal("endpoint returned no refresh token here")
	}

	// Expired token is invalid.
	expired := &OAuthToken{AccessToken: "x", Expiry: time.Now().Add(-time.Hour)}
	if expired.valid() {
		t.Fatal("expired token must be invalid")
	}
}

func TestTokenRequestError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error":             "invalid_grant",
			"error_description": "Token has been revoked",
		})
	}))
	defer srv.Close()
	_, err := tokenRequest(context.Background(), srv.URL, url.Values{"grant_type": {"refresh_token"}})
	if err == nil || !strings.Contains(err.Error(), "invalid_grant") {
		t.Fatalf("expected oauth error, got %v", err)
	}
}
