package handler

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yuweinfo/xcontrol/model"
	gossh "golang.org/x/crypto/ssh"
)

type vaultHandlerTestStore struct {
	storedType     string
	storedUsername string
}

func (s *vaultHandlerTestStore) Store(_ *model.Credential, credType, _, username, _ string) (string, error) {
	s.storedType = credType
	s.storedUsername = username
	return "vault", nil
}
func (s *vaultHandlerTestStore) Retrieve(string) (*model.Credential, error) { return &model.Credential{}, nil }
func (s *vaultHandlerTestStore) Update(string, *model.Credential, string, string, string, string) error {
	return nil
}
func (s *vaultHandlerTestStore) Delete(string) error { return nil }
func (s *vaultHandlerTestStore) List(model.VaultListFilter) ([]*model.VaultItem, error) {
	return []*model.VaultItem{}, nil
}
func (s *vaultHandlerTestStore) Get(string) (*model.VaultItem, error) {
	return &model.VaultItem{ID: "vault", Type: s.storedType, Username: s.storedUsername}, nil
}
func (s *vaultHandlerTestStore) RefCount(string) (int, error) { return 0, nil }
func (s *vaultHandlerTestStore) References(string) ([]model.ProfileRef, error) {
	return []model.ProfileRef{}, nil
}

type vaultHandlerTestAudit struct{}

func (vaultHandlerTestAudit) Log(*model.AuditLog) error { return nil }
func (vaultHandlerTestAudit) List(string, int) ([]*model.AuditLog, error) {
	return []*model.AuditLog{}, nil
}

func TestEnsurePublicKeyDerivesFromPrivateKey(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	block, err := gossh.MarshalPrivateKey(privateKey, "")
	if err != nil {
		t.Fatalf("marshal private key: %v", err)
	}

	cred := &model.Credential{
		PrivKey: strings.TrimSpace(string(pem.EncodeToMemory(block))),
	}

	ensurePublicKey(cred, model.VaultTypePrivateKey)

	if !strings.HasPrefix(cred.PublicKey, "ssh-ed25519 ") {
		t.Fatalf("expected derived public key, got %q", cred.PublicKey)
	}
}

func TestEnsurePublicKeyPreservesProvidedValue(t *testing.T) {
	cred := &model.Credential{
		PrivKey:   "ignored",
		PublicKey: "ssh-ed25519 AAAAexisting user@test",
	}

	ensurePublicKey(cred, model.VaultTypePrivateKey)

	if cred.PublicKey != "ssh-ed25519 AAAAexisting user@test" {
		t.Fatalf("expected explicit public key to be preserved, got %q", cred.PublicKey)
	}
}

func TestValidateVaultTypeUpdate(t *testing.T) {
	if err := validateVaultTypeUpdate(model.VaultTypePrivateKey, model.VaultTypePrivateKey); err != nil {
		t.Fatalf("expected matching type update to succeed, got %v", err)
	}

	if err := validateVaultTypeUpdate(model.VaultTypePrivateKey, model.VaultTypePassword); err == nil {
		t.Fatal("expected changing credential type to be rejected")
	}
}

func TestNormalizedVaultUsername(t *testing.T) {
	if got := normalizedVaultUsername(model.VaultTypePassword, "  root  "); got != "root" {
		t.Fatalf("password username = %q", got)
	}
	if got := normalizedVaultUsername(model.VaultTypePrivateKey, "root"); got != "" {
		t.Fatalf("private key username = %q", got)
	}
}

func TestVaultCreateUsernameRules(t *testing.T) {
	store := &vaultHandlerTestStore{}
	handler := NewVaultHandler(store, vaultHandlerTestAudit{})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/vault", bytes.NewBufferString(
		`{"name":"key","type":"private_key","username":"root","private_key":"key"}`,
	))
	handler.Create(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("private key create status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.storedUsername != "" {
		t.Fatalf("private key username = %q", store.storedUsername)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/vault", bytes.NewBufferString(
		`{"name":"password","type":"password","password":"secret"}`,
	))
	handler.Create(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("password create status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}
