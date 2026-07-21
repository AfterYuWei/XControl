package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/yuweinfo/xcontrol/model"
)

// OAuth2 endpoints. Both providers use the standard authorization-code flow.
const (
	gdriveAuthURL  = "https://accounts.google.com/o/oauth2/v2/auth"
	gdriveTokenURL = "https://oauth2.googleapis.com/token"
	gdriveScope    = "https://www.googleapis.com/auth/drive.file" // app-created files only

	onedriveAuthURL  = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
	onedriveTokenURL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
	onedriveScope    = "Files.ReadWrite offline_access"
)

// OAuthToken is the decrypted token triple persisted in provider config.
type OAuthToken struct {
	AccessToken  string
	RefreshToken string
	Expiry       time.Time
}

func (t *OAuthToken) valid() bool {
	return t.AccessToken != "" && time.Now().Before(t.Expiry.Add(-90*time.Second))
}

// oauthState guards the authorization round-trip against CSRF.
type oauthState struct {
	providerID string
	expiresAt  time.Time
}

var oauthStates = struct {
	sync.Mutex
	m map[string]oauthState
}{m: map[string]oauthState{}}

func newOAuthState(providerID string) string {
	state := uuid.NewString()
	oauthStates.Lock()
	oauthStates.m[state] = oauthState{providerID: providerID, expiresAt: time.Now().Add(10 * time.Minute)}
	oauthStates.Unlock()
	return state
}

// consumeOAuthState validates and removes a state token.
func consumeOAuthState(state string) (string, bool) {
	oauthStates.Lock()
	defer oauthStates.Unlock()
	s, ok := oauthStates.m[state]
	if !ok || time.Now().After(s.expiresAt) {
		return "", false
	}
	delete(oauthStates.m, state)
	return s.providerID, true
}

// BuildAuthURL returns the provider's authorization URL for a provider row.
func BuildAuthURL(providerType string, cfg *model.SyncProviderConfig, redirectURI, state string) (string, error) {
	q := url.Values{}
	q.Set("client_id", cfg.OAuthClientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("response_type", "code")
	q.Set("state", state)
	switch providerType {
	case "gdrive":
		q.Set("scope", gdriveScope)
		q.Set("access_type", "offline")
		q.Set("prompt", "consent") // ensures refresh_token on re-auth
		return gdriveAuthURL + "?" + q.Encode(), nil
	case "onedrive":
		q.Set("scope", onedriveScope)
		return onedriveAuthURL + "?" + q.Encode(), nil
	default:
		return "", fmt.Errorf("unsupported oauth provider type: %s", providerType)
	}
}

// tokenEndpoint maps provider type to its token URL.
func tokenEndpoint(providerType string) (string, error) {
	switch providerType {
	case "gdrive":
		return gdriveTokenURL, nil
	case "onedrive":
		return onedriveTokenURL, nil
	default:
		return "", fmt.Errorf("unsupported oauth provider type: %s", providerType)
	}
}

// ExchangeCode trades an authorization code for tokens.
func ExchangeCode(ctx context.Context, providerType string, cfg *model.SyncProviderConfig, code, redirectURI string) (*OAuthToken, error) {
	endpoint, err := tokenEndpoint(providerType)
	if err != nil {
		return nil, err
	}
	form := url.Values{
		"client_id":     {cfg.OAuthClientID},
		"client_secret": {cfg.OAuthClientSecret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {redirectURI},
	}
	return tokenRequest(ctx, endpoint, form)
}

// RefreshTokens exchanges a refresh token for a new access token. When the
// provider rotates refresh tokens (Microsoft does), the new one is returned;
// otherwise the old refresh token is preserved.
func RefreshTokens(ctx context.Context, providerType string, cfg *model.SyncProviderConfig) (*OAuthToken, error) {
	endpoint, err := tokenEndpoint(providerType)
	if err != nil {
		return nil, err
	}
	form := url.Values{
		"client_id":     {cfg.OAuthClientID},
		"client_secret": {cfg.OAuthClientSecret},
		"refresh_token": {cfg.OAuthRefreshToken},
		"grant_type":    {"refresh_token"},
	}
	tok, err := tokenRequest(ctx, endpoint, form)
	if err != nil {
		return nil, err
	}
	if tok.RefreshToken == "" {
		tok.RefreshToken = cfg.OAuthRefreshToken
	}
	return tok, nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

func tokenRequest(ctx context.Context, endpoint string, form url.Values) (*OAuthToken, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token 请求失败: %w", err)
	}
	defer resp.Body.Close()
	var tr tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return nil, fmt.Errorf("token 响应解析失败: %w", err)
	}
	if tr.Error != "" {
		return nil, fmt.Errorf("oauth 错误: %s (%s)", tr.Error, tr.ErrorDesc)
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("oauth 响应缺少 access_token (HTTP %d)", resp.StatusCode)
	}
	expiry := time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	if tr.ExpiresIn == 0 {
		expiry = time.Now().Add(time.Hour)
	}
	return &OAuthToken{AccessToken: tr.AccessToken, RefreshToken: tr.RefreshToken, Expiry: expiry}, nil
}
