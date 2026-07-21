package sync

import (
	"context"
	"fmt"
)

// BuildOAuthURL returns the authorization URL for a provider row, registering
// a CSRF state token bound to that provider id.
func (m *Manager) BuildOAuthURL(ctx context.Context, providerType, providerID, redirectURI string) (string, error) {
	row, err := m.providers.Get(providerID)
	if err != nil {
		return "", fmt.Errorf("provider 不存在")
	}
	if row.Config.Type != providerType {
		return "", fmt.Errorf("provider 类型不匹配")
	}
	if row.Config.OAuthClientID == "" {
		return "", fmt.Errorf("请先填写 OAuth Client ID")
	}
	state := newOAuthState(providerID)
	return BuildAuthURL(providerType, &row.Config, redirectURI, state)
}

// CompleteOAuth handles the browser redirect: validates state, exchanges the
// code for tokens and persists them (encrypted) into the provider config.
func (m *Manager) CompleteOAuth(ctx context.Context, providerType, state, code, redirectURI string) error {
	providerID, ok := consumeOAuthState(state)
	if !ok {
		return fmt.Errorf("授权状态无效或已过期，请重新发起授权")
	}
	row, err := m.providers.Get(providerID)
	if err != nil {
		return fmt.Errorf("provider 不存在")
	}
	if row.Config.Type != providerType {
		return fmt.Errorf("provider 类型不匹配")
	}
	tok, err := ExchangeCode(ctx, providerType, &row.Config, code, redirectURI)
	if err != nil {
		return err
	}
	if tok.RefreshToken == "" {
		return fmt.Errorf("未获得 refresh_token（Google 授权需勾选离线访问权限，请重试）")
	}
	row.Config.OAuthAccessToken = tok.AccessToken
	row.Config.OAuthRefreshToken = tok.RefreshToken
	row.Config.OAuthExpiry = tok.Expiry
	if err := m.providers.SaveConfig(providerID, &row.Config); err != nil {
		return err
	}
	m.versions.LogEvent(providerID, "oauth", 0, true, "authorized")
	return nil
}
