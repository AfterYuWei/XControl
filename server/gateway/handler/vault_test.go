package handler

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"strings"
	"testing"

	"github.com/yuweinfo/xcontrol/model"
	gossh "golang.org/x/crypto/ssh"
)

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
