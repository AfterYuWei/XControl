package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yuweinfo/xcontrol/model"
)

type profileHandlerTestStore struct {
	created *model.Profile
}

func (s *profileHandlerTestStore) List(string, string) ([]*model.Profile, error) {
	return []*model.Profile{}, nil
}
func (s *profileHandlerTestStore) Get(string) (*model.Profile, error) { return s.created, nil }
func (s *profileHandlerTestStore) Create(profile *model.Profile) error {
	s.created = profile
	return nil
}
func (s *profileHandlerTestStore) Update(string, *model.ProfileUpdateRequest) error { return nil }
func (s *profileHandlerTestStore) Delete(string) error { return nil }
func (s *profileHandlerTestStore) UpdateLastUsed(string) error { return nil }
func (s *profileHandlerTestStore) CountByGroup(string) (int, error) { return 0, nil }

func TestApplyVaultUsername(t *testing.T) {
	var got string
	password := &model.VaultItem{Type: model.VaultTypePassword, Username: " admin "}
	if err := applyVaultUsername(password, "", func(username string) { got = username }); err != nil {
		t.Fatal(err)
	}
	if got != "admin" {
		t.Fatalf("username = %q", got)
	}
	if err := applyVaultUsername(password, "root", func(string) {}); err == nil {
		t.Fatal("expected mismatched password vault username to fail")
	}
	if err := applyVaultUsername(&model.VaultItem{Type: model.VaultTypePassword}, "", func(string) {}); err == nil {
		t.Fatal("expected incomplete password vault to fail")
	}
	if err := applyVaultUsername(&model.VaultItem{Type: model.VaultTypePrivateKey}, "deploy", func(username string) { got = username }); err != nil {
		t.Fatal(err)
	}
	if got != "deploy" {
		t.Fatalf("key profile username = %q", got)
	}
}

func TestProfileCreateVaultUsernameRules(t *testing.T) {
	profiles := &profileHandlerTestStore{}
	vault := &vaultHandlerTestStore{storedType: model.VaultTypePassword, storedUsername: "admin"}
	handler := NewProfileHandler(profiles, vault, nil)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/profiles", bytes.NewBufferString(
		`{"name":"server","host":"example.com","auth_type":"vault","vault_id":"vault"}`,
	))
	handler.Create(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("password vault profile status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if profiles.created == nil || profiles.created.Username != "admin" {
		t.Fatalf("profile username = %#v", profiles.created)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/profiles", bytes.NewBufferString(
		`{"name":"server","host":"example.com","username":"root","auth_type":"vault","vault_id":"vault"}`,
	))
	handler.Create(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("mismatched username status = %d", recorder.Code)
	}

	vault.storedType = model.VaultTypePrivateKey
	vault.storedUsername = ""
	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/profiles", bytes.NewBufferString(
		`{"name":"server","host":"example.com","auth_type":"vault","vault_id":"vault"}`,
	))
	handler.Create(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("private key vault username status = %d", recorder.Code)
	}
}

func TestProfileUpdateKeepsUsernameForPrivateKeyVault(t *testing.T) {
	vault := &vaultHandlerTestStore{storedType: model.VaultTypePrivateKey}
	handler := NewProfileHandler(&profileHandlerTestStore{}, vault, nil)
	current := &model.Profile{
		Username: "deploy",
		AuthType: "vault",
		VaultID:  "vault",
	}
	req := &model.ProfileUpdateRequest{}

	if err := handler.prepareCredentialOnUpdate(current, req); err != nil {
		t.Fatal(err)
	}
	if req.Username == nil || *req.Username != "deploy" {
		t.Fatalf("updated username = %#v", req.Username)
	}
}
