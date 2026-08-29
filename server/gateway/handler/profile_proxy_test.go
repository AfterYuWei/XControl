package handler

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
)

type proxyProfileStore struct{ profiles map[string]*model.Profile }

func (s *proxyProfileStore) List(string, string) ([]*model.Profile, error) {
	result := make([]*model.Profile, 0, len(s.profiles))
	for _, profile := range s.profiles {
		result = append(result, profile)
	}
	return result, nil
}
func (s *proxyProfileStore) Get(id string) (*model.Profile, error) {
	if profile := s.profiles[id]; profile != nil {
		return profile, nil
	}
	return nil, fmt.Errorf("not found")
}
func (s *proxyProfileStore) Create(*model.Profile) error                      { return nil }
func (s *proxyProfileStore) Update(string, *model.ProfileUpdateRequest) error { return nil }
func (s *proxyProfileStore) Delete(string) error                              { return nil }
func (s *proxyProfileStore) UpdateLastUsed(string) error                      { return nil }
func (s *proxyProfileStore) CountByGroup(string) (int, error)                 { return 0, nil }
func (s *proxyProfileStore) JumpReferences(id string) ([]model.ProfileRef, error) {
	var refs []model.ProfileRef
	for _, profile := range s.profiles {
		if profile.Proxy.Type == model.ProxyTypeJump && profile.Proxy.JumpProfileID == id {
			refs = append(refs, model.ProfileRef{ID: profile.ID, Name: profile.Name})
		}
	}
	return refs, nil
}

func TestValidateProxyChainRejectsCycleAndDepth(t *testing.T) {
	store := &proxyProfileStore{profiles: map[string]*model.Profile{}}
	store.profiles["a"] = &model.Profile{ID: "a", Name: "A", Proxy: model.ProxyConfig{Type: model.ProxyTypeJump, JumpProfileID: "b"}}
	store.profiles["b"] = &model.Profile{ID: "b", Name: "B", Proxy: model.ProxyConfig{Type: model.ProxyTypeJump, JumpProfileID: "a"}}
	if err := validateProxyChain(store, "a", store.profiles["a"].Proxy); err == nil || !strings.Contains(err.Error(), "循环") {
		t.Fatalf("expected cycle error, got %v", err)
	}

	store.profiles = map[string]*model.Profile{}
	for i := 0; i < maxJumpProfiles+1; i++ {
		id := fmt.Sprintf("p%d", i)
		next := fmt.Sprintf("p%d", i+1)
		store.profiles[id] = &model.Profile{ID: id, Name: id, Proxy: model.ProxyConfig{Type: model.ProxyTypeJump, JumpProfileID: next}}
	}
	store.profiles[fmt.Sprintf("p%d", maxJumpProfiles+1)] = &model.Profile{ID: "end", Name: "end", Proxy: model.DirectProxyConfig()}
	if err := validateProxyChain(store, "root", model.ProxyConfig{Type: model.ProxyTypeJump, JumpProfileID: "p0"}); err == nil || !strings.Contains(err.Error(), "最多") {
		t.Fatalf("expected depth error, got %v", err)
	}
}

func TestPrepareProxyUpdatePasswordSemantics(t *testing.T) {
	enc, err := crypto.NewEncryptor(filepath.Join(t.TempDir(), "key"))
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := encodeProxyPassword("secret", enc)
	if err != nil {
		t.Fatal(err)
	}
	current := &model.Profile{
		ID: "current", Options: `{}`, UpdatedAt: time.Now(), ProxyCredential: encrypted,
		Proxy: model.ProxyConfig{Type: model.ProxyTypeSOCKS5, Host: "proxy", Port: 1080, Username: "alice", HasPassword: true},
	}
	current.Options, _ = model.WithProxyOptions(current.Options, current.Proxy)
	handler := NewProfileHandler(&proxyProfileStore{profiles: map[string]*model.Profile{"current": current}}, nil, enc)
	req := &model.ProfileUpdateRequest{Proxy: &model.ProxyInput{Type: model.ProxyTypeSOCKS5, Host: "proxy", Port: 1080, Username: "alice"}}
	if err := handler.prepareProxyOnUpdate(current, req); err != nil {
		t.Fatal(err)
	}
	if req.ProxyCredential == nil || *req.ProxyCredential != encrypted {
		t.Fatal("unchanged proxy should preserve encrypted password")
	}

	req = &model.ProfileUpdateRequest{Proxy: &model.ProxyInput{Type: model.ProxyTypeSOCKS5, Host: "other", Port: 1080, Username: "alice"}}
	if err := handler.prepareProxyOnUpdate(current, req); err == nil {
		t.Fatal("changed proxy identity should require a new password")
	}
	empty := ""
	req = &model.ProfileUpdateRequest{Proxy: &model.ProxyInput{Type: model.ProxyTypeSOCKS5, Host: "proxy", Port: 1080, Password: &empty}}
	if err := handler.prepareProxyOnUpdate(current, req); err != nil {
		t.Fatal(err)
	}
	if req.ProxyCredential == nil || *req.ProxyCredential != "" {
		t.Fatal("explicit empty password should clear credential")
	}
}
