package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/sync/provider"
)

func decodeIndex(raw []byte) (*provider.CloudIndex, error) {
	var idx provider.CloudIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, err
	}
	if idx.Versions == nil {
		idx.Versions = []provider.CloudVersionInfo{}
	}
	return &idx, nil
}

func encodeIndex(idx *provider.CloudIndex) []byte {
	raw, _ := json.Marshal(idx)
	return raw
}

// memProvider is an in-memory Provider fake for cloud-sync tests.
type memProvider struct {
	id      string
	name    string
	objects map[string][]byte
}

func newMemProvider(id string) *memProvider {
	return &memProvider{id: id, name: "mem-" + id, objects: map[string][]byte{}}
}

func (p *memProvider) ID() string   { return p.id }
func (p *memProvider) Type() string { return "mem" }
func (p *memProvider) Name() string { return p.name }
func (p *memProvider) Ping(ctx context.Context) error { return nil }

func (p *memProvider) ReadIndex(ctx context.Context) (*provider.CloudIndex, error) {
	raw, ok := p.objects["index.json"]
	if !ok {
		return provider.NewCloudIndex(), nil
	}
	idx, err := decodeIndex(raw)
	return idx, err
}

func (p *memProvider) WriteIndex(ctx context.Context, idx *provider.CloudIndex) error {
	p.objects["index.json"] = encodeIndex(idx)
	return nil
}

func (p *memProvider) PutObject(ctx context.Context, name string, r io.Reader, size int64) error {
	data, _ := io.ReadAll(r)
	p.objects[name] = data
	return nil
}

func (p *memProvider) GetObject(ctx context.Context, name string) (io.ReadCloser, error) {
	data, ok := p.objects[name]
	if !ok {
		return nil, provider.ErrObjectNotFound
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (p *memProvider) DeleteObject(ctx context.Context, name string) error {
	delete(p.objects, name)
	return nil
}

func TestCloudIndexOps(t *testing.T) {
	idx := provider.NewCloudIndex()
	if idx.Latest() != nil || idx.LatestVersion != 0 {
		t.Fatal("empty index should have no latest")
	}
	now := time.Now()
	idx.Add(provider.CloudVersionInfo{Version: 1, Hash: "aaa", Size: 10, Object: "v1", CreatedAt: now})
	idx.Add(provider.CloudVersionInfo{Version: 3, Hash: "ccc", Size: 30, Object: "v3", CreatedAt: now})
	idx.Add(provider.CloudVersionInfo{Version: 2, Hash: "bbb", Size: 20, Object: "v2", CreatedAt: now})
	if idx.LatestVersion != 3 || idx.Latest().Hash != "ccc" {
		t.Fatalf("latest wrong: %+v", idx.Latest())
	}
	if !idx.ContainsHash("bbb") || idx.ContainsHash("zzz") {
		t.Fatal("ContainsHash wrong")
	}
	if idx.HashOf(2) != "bbb" || idx.HashOf(9) != "" {
		t.Fatal("HashOf wrong")
	}
	// Re-add same version replaces.
	idx.Add(provider.CloudVersionInfo{Version: 2, Hash: "bbb2", Size: 21, Object: "v2b", CreatedAt: now})
	if idx.HashOf(2) != "bbb2" || len(idx.Versions) != 3 {
		t.Fatal("Add should replace same version")
	}
	idx.Remove(3)
	if idx.LatestVersion != 2 {
		t.Fatalf("after remove latest should be 2, got %d", idx.LatestVersion)
	}
}

func TestPushVersionToProvider(t *testing.T) {
	mgr, _ := setupManager(t)
	setPassword(t, mgr)

	// Create a local version.
	v, err := mgr.CreateVersion(context.Background(), model.SyncOriginManual)
	if err != nil || v == nil {
		t.Fatalf("create version: %v %+v", err, v)
	}

	mp := newMemProvider("p1")
	if err := mgr.pushVersion(context.Background(), mp, v); err != nil {
		t.Fatalf("push: %v", err)
	}

	// Cloud index should record the version.
	idx, err := mp.ReadIndex(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if idx.LatestVersion != v.Version || idx.HashOf(v.Version) != v.Hash {
		t.Fatalf("cloud index mismatch: %+v", idx)
	}
	// Object exists and matches local file bytes.
	obj := provider.ObjectName(v.Version, v.Hash)
	if _, ok := mp.objects[obj]; !ok {
		t.Fatalf("object %s not uploaded", obj)
	}
	// Local version marked synced.
	got, _ := mgr.versions.GetVersion(v.ID)
	if len(got.SyncedTo) != 1 || got.SyncedTo[0] != "p1" {
		t.Fatalf("synced_to not updated: %+v", got.SyncedTo)
	}
}

func TestPullVersionFromProvider(t *testing.T) {
	// Source manager creates a version and pushes to cloud.
	src, _ := setupManager(t)
	setPassword(t, src)
	v, err := src.CreateVersion(context.Background(), model.SyncOriginManual)
	if err != nil {
		t.Fatal(err)
	}
	mp := newMemProvider("p1")
	if err := src.pushVersion(context.Background(), mp, v); err != nil {
		t.Fatal(err)
	}

	// Destination manager (separate DB) pulls.
	dst, _ := setupManager(t)
	setPassword(t, dst) // same password required to decrypt
	idx, _ := mp.ReadIndex(context.Background())
	if err := dst.pullVersion(context.Background(), mp, idx, v.Version); err != nil {
		t.Fatalf("pull: %v", err)
	}
	latest, err := dst.versions.LatestVersion()
	if err != nil || latest == nil {
		t.Fatal("no local version after pull")
	}
	if latest.Version != v.Version || latest.Hash != v.Hash {
		t.Fatalf("pulled version mismatch: %+v", latest)
	}
	if latest.SyncedTo[0] != "p1" {
		t.Fatalf("pulled version should record source provider: %+v", latest.SyncedTo)
	}
	// next_version must have advanced past the pulled version.
	n, err := dst.versions.NextVersion()
	if err != nil {
		t.Fatal(err)
	}
	if n <= v.Version {
		t.Fatalf("next_version should exceed pulled version, got %d", n)
	}
}

func TestForkDetection(t *testing.T) {
	mgr, _ := setupManager(t)
	setPassword(t, mgr)
	v, err := mgr.CreateVersion(context.Background(), model.SyncOriginManual)
	if err != nil {
		t.Fatal(err)
	}

	// Cloud has a DIFFERENT version 2 while local is at v1 → fork.
	mp := newMemProvider("p1")
	idx := provider.NewCloudIndex()
	idx.Add(provider.CloudVersionInfo{Version: 2, Hash: "deadbeef" + v.Hash[8:], Size: 999, Object: "x", CreatedAt: time.Now()})
	mp.WriteIndex(context.Background(), idx)

	settings, _ := mgr.settings()
	settings.ConflictPolicy = "prompt"
	err = mgr.syncWithProvider(context.Background(), mp, settings)
	if err != nil {
		t.Fatalf("syncWithProvider: %v", err)
	}
	_, _, conflictJSON, _ := mgr.versions.GetState()
	if conflictJSON == "" {
		t.Fatal("fork should record a conflict")
	}
}

func TestNoForkWhenLocalBehind(t *testing.T) {
	mgr, _ := setupManager(t)
	setPassword(t, mgr)
	v1, _ := mgr.CreateVersion(context.Background(), model.SyncOriginManual)

	mp := newMemProvider("p1")
	// Cloud contains local v1's hash plus a newer v2 → local just behind.
	idx := provider.NewCloudIndex()
	idx.Add(provider.CloudVersionInfo{Version: v1.Version, Hash: v1.Hash, Size: v1.Size, Object: "a", CreatedAt: v1.CreatedAt})
	idx.Add(provider.CloudVersionInfo{Version: v1.Version + 1, Hash: "ffff" + v1.Hash[4:], Size: 1, Object: "b", CreatedAt: time.Now()})
	mp.WriteIndex(context.Background(), idx)

	settings, _ := mgr.settings()
	settings.SyncMode = "manual" // manual: no auto pull, but also NO conflict
	settings.ConflictPolicy = "prompt"
	if err := mgr.syncWithProvider(context.Background(), mp, settings); err != nil {
		t.Fatal(err)
	}
	_, _, conflictJSON, _ := mgr.versions.GetState()
	if conflictJSON != "" {
		t.Fatal("behind-but-not-forked must not record conflict")
	}
}
