package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
)

func setupBackupTest(t *testing.T) (*BackupStore, func()) {
	t.Helper()
	dir := t.TempDir()
	db, err := InitDB(filepath.Join(dir, "data.db"))
	if err != nil {
		t.Fatalf("init db: %v", err)
	}
	enc, err := crypto.NewEncryptor(filepath.Join(dir, "key"))
	if err != nil {
		t.Fatalf("new encryptor: %v", err)
	}
	return NewBackupStore(db, enc), func() { db.Close() }
}

func TestBackupExportImportRoundTrip(t *testing.T) {
	src, cleanup := setupBackupTest(t)
	defer cleanup()

	// Seed source DB via the public stores.
	now := time.Now().Truncate(time.Second)
	group := &model.Group{ID: uuid.NewString(), Name: "生产", Icon: "folder", CreatedAt: now}
	child := &model.Group{ID: uuid.NewString(), Name: "子组", ParentID: group.ID, Icon: "folder", CreatedAt: now}
	gs := NewGroupStore(src.db)
	if err := gs.Create(group); err != nil {
		t.Fatal(err)
	}
	if err := gs.Create(child); err != nil {
		t.Fatal(err)
	}

	vs := NewVaultStore(src.db, src.encryptor)
	vaultID, err := vs.Store(&model.Credential{Password: "s3cret"}, model.VaultTypePassword, "root密码", "root", "")
	if err != nil {
		t.Fatal(err)
	}

	inline, err := EncodeInlineCredential(src.encryptor, &model.Credential{Password: "p@ss"})
	if err != nil {
		t.Fatal(err)
	}
	ps := NewProfileStore(src.db)
	profile := &model.Profile{
		ID: uuid.NewString(), Name: "web-1", Host: "10.0.0.1", Port: 22,
		Username: "root", AuthType: "password", Icon: "server",
		InlineCredential: inline, GroupID: child.ID,
		Tags: []string{"web"}, Options: "{}", CreatedAt: now, UpdatedAt: now,
	}
	if err := ps.Create(profile); err != nil {
		t.Fatal(err)
	}
	vaultProfile := &model.Profile{
		ID: uuid.NewString(), Name: "db-1", Host: "10.0.0.2", Port: 22,
		Username: "root", AuthType: "vault", Icon: "database", VaultID: vaultID,
		Tags: []string{}, Options: "{}", CreatedAt: now, UpdatedAt: now,
	}
	if err := ps.Create(vaultProfile); err != nil {
		t.Fatal(err)
	}

	ss := NewSnippetStore(src.db)
	snippet := &model.Snippet{ID: uuid.NewString(), Name: "磁盘", Content: "df -h", Tags: []string{}, IsGlobal: true, CreatedAt: now, UpdatedAt: now}
	if err := ss.Create(snippet); err != nil {
		t.Fatal(err)
	}

	// Export.
	payload, err := src.Export()
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if len(payload.Groups) != 2 || len(payload.Profiles) != 2 || len(payload.Vault) != 1 || len(payload.Snippets) != 1 {
		t.Fatalf("unexpected export counts: %+v", payload)
	}
	if payload.Profiles[0].InlineCredential == nil && payload.Profiles[1].InlineCredential == nil {
		t.Fatal("inline credentials should be decrypted in export payload")
	}
	if payload.Vault[0].Credential == nil || payload.Vault[0].Credential.Password != "s3cret" {
		t.Fatalf("vault credential not decrypted: %+v", payload.Vault[0].Credential)
	}

	// Serialize through JSON to simulate file round trip.
	raw, _ := json.Marshal(payload)
	var decoded model.BackupPayload
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	// Import into a fresh DB.
	dst, cleanup2 := setupBackupTest(t)
	defer cleanup2()
	result, err := dst.Import(&decoded, model.BackupStrategySkip)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if result.Imported.Groups != 2 || result.Imported.Profiles != 2 || result.Imported.Vault != 1 || result.Imported.Snippets != 1 {
		t.Fatalf("unexpected import result: %+v", result.Imported)
	}

	// Verify references intact.
	got, err := NewProfileStore(dst.db).Get(profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.GroupID != child.ID {
		t.Fatalf("group reference lost: %q", got.GroupID)
	}
	cred, err := DecodeInlineCredential(dst.encryptor, got.InlineCredential)
	if err != nil || cred.Password != "p@ss" {
		t.Fatalf("inline credential mismatch: %v %+v", err, cred)
	}
	gotVault, err := NewProfileStore(dst.db).Get(vaultProfile.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotVault.VaultID != vaultID {
		t.Fatalf("vault reference lost: %q", gotVault.VaultID)
	}
	vc, err := NewVaultStore(dst.db, dst.encryptor).Retrieve(vaultID)
	if err != nil || vc.Password != "s3cret" {
		t.Fatalf("vault credential mismatch: %v %+v", err, vc)
	}

	// Skip strategy: second import skips everything.
	result2, err := dst.Import(&decoded, model.BackupStrategySkip)
	if err != nil {
		t.Fatal(err)
	}
	if result2.Skipped.Profiles != 2 || result2.Imported.Profiles != 0 {
		t.Fatalf("skip strategy failed: %+v", result2)
	}

	// Regenerate strategy: everything duplicated with new IDs, refs remapped.
	result3, err := dst.Import(&decoded, model.BackupStrategyRegenerate)
	if err != nil {
		t.Fatal(err)
	}
	if result3.Imported.Profiles != 2 || result3.Imported.Groups != 2 || result3.Imported.Vault != 1 {
		t.Fatalf("regenerate import failed: %+v", result3.Imported)
	}
	profiles, err := NewProfileStore(dst.db).List("", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 4 {
		t.Fatalf("expected 4 profiles after regenerate, got %d", len(profiles))
	}
	// The regenerated vault profile must point at the regenerated vault entry.
	var dupCount int
	for _, p := range profiles {
		if p.Name == "db-1" && p.VaultID != vaultID && p.VaultID != "" {
			dupCount++
			if _, err := NewVaultStore(dst.db, dst.encryptor).Retrieve(p.VaultID); err != nil {
				t.Fatalf("regenerated vault reference dangles: %v", err)
			}
		}
	}
	if dupCount != 1 {
		t.Fatalf("expected 1 regenerated vault profile, got %d", dupCount)
	}
}

func TestTopoSortGroupsCycle(t *testing.T) {
	groups := []*model.Group{
		{ID: "a", ParentID: "b"},
		{ID: "b", ParentID: "a"},
	}
	if _, err := topoSortGroups(groups); err == nil {
		t.Fatal("cycle should be rejected")
	}

	ok := []*model.Group{
		{ID: "child", ParentID: "root"},
		{ID: "root"},
		{ID: "grandchild", ParentID: "child"},
	}
	ordered, err := topoSortGroups(ok)
	if err != nil {
		t.Fatal(err)
	}
	pos := map[string]int{}
	for i, g := range ordered {
		pos[g.ID] = i
	}
	if !(pos["root"] < pos["child"] && pos["child"] < pos["grandchild"]) {
		t.Fatalf("wrong order: %v", ordered)
	}
}

func TestKDFParamsValidate(t *testing.T) {
	p, err := crypto.NewKDFParams()
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Validate(); err != nil {
		t.Fatalf("default params should be valid: %v", err)
	}
	p.Memory = 1 << 22
	if err := p.Validate(); err == nil {
		t.Fatal("oversized memory should be rejected")
	}
	if _, err := os.Stat("/nonexistent"); err == nil {
		t.Fatal("sanity check failed")
	}
}
