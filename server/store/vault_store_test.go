package store

import (
	"testing"
	"time"

	"github.com/yuweinfo/xcontrol/model"
)

func TestVaultStoreNormalizesKeyUsernameAndCascadesPasswordUsername(t *testing.T) {
	backups, cleanup := setupBackupTest(t)
	defer cleanup()
	store := NewVaultStore(backups.db, backups.encryptor)

	keyID, err := store.Store(&model.Credential{PrivKey: "key"}, model.VaultTypePrivateKey, "key", "root", "")
	if err != nil {
		t.Fatal(err)
	}
	keyItem, err := store.Get(keyID)
	if err != nil {
		t.Fatal(err)
	}
	if keyItem.Username != "" {
		t.Fatalf("private key username = %q", keyItem.Username)
	}

	passwordID, err := store.Store(&model.Credential{Password: "old"}, model.VaultTypePassword, "password", "root", "")
	if err != nil {
		t.Fatal(err)
	}
	profile := &model.Profile{
		ID: "profile", Name: "profile", Host: "host", Port: 22, Username: "root",
		AuthType: "vault", VaultID: passwordID, Tags: []string{}, Options: "{}",
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := NewProfileStore(backups.db).Create(profile); err != nil {
		t.Fatal(err)
	}
	if err := store.Update(passwordID, &model.Credential{Password: "new"}, model.VaultTypePassword, "password", " admin ", ""); err != nil {
		t.Fatal(err)
	}
	updated, err := NewProfileStore(backups.db).Get(profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Username != "admin" {
		t.Fatalf("profile username = %q", updated.Username)
	}
}

func TestVaultStoreUsernameCascadeRollsBackWithVaultUpdate(t *testing.T) {
	backups, cleanup := setupBackupTest(t)
	defer cleanup()
	store := NewVaultStore(backups.db, backups.encryptor)
	passwordID, err := store.Store(&model.Credential{Password: "old"}, model.VaultTypePassword, "password", "root", "")
	if err != nil {
		t.Fatal(err)
	}
	profile := &model.Profile{
		ID: "profile", Name: "profile", Host: "host", Port: 22, Username: "root",
		AuthType: "vault", VaultID: passwordID, Tags: []string{}, Options: "{}",
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := NewProfileStore(backups.db).Create(profile); err != nil {
		t.Fatal(err)
	}
	if _, err := backups.db.Exec(`CREATE TRIGGER reject_profile_username BEFORE UPDATE OF username ON profiles BEGIN SELECT RAISE(ABORT, 'reject'); END`); err != nil {
		t.Fatal(err)
	}
	if err := store.Update(passwordID, &model.Credential{Password: "new"}, model.VaultTypePassword, "password", "admin", ""); err == nil {
		t.Fatal("expected cascade failure")
	}
	item, err := store.Get(passwordID)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := store.Retrieve(passwordID)
	if err != nil {
		t.Fatal(err)
	}
	if item.Username != "root" || credential.Password != "old" {
		t.Fatalf("vault update was not rolled back: username=%q password=%q", item.Username, credential.Password)
	}
}
