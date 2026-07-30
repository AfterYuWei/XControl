package store

import (
	"path/filepath"
	"testing"
)

func TestInitDBConfiguresSQLiteAndVersionsMigrations(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "xcontrol.db")
	db, err := InitDB(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var foreignKeys, busyTimeout int
	var journalMode string
	if err := db.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`PRAGMA busy_timeout`).Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 {
		t.Fatalf("foreign_keys = %d", foreignKeys)
	}
	if busyTimeout != 5000 {
		t.Fatalf("busy_timeout = %d", busyTimeout)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q", journalMode)
	}

	var migrationCount, maxVersion int
	if err := db.QueryRow(`SELECT COUNT(*), MAX(version) FROM schema_migrations`).
		Scan(&migrationCount, &maxVersion); err != nil {
		t.Fatal(err)
	}
	if migrationCount != 3 || maxVersion != 3 {
		t.Fatalf("migrations = %d max = %d", migrationCount, maxVersion)
	}
}

func TestMigrationsAreIdempotentAcrossReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "xcontrol.db")
	db, err := InitDB(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := InitDB(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()

	var count int
	if err := reopened.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("migration count after reopen = %d", count)
	}
}
