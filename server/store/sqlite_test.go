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
	if migrationCount != 5 || maxVersion != 5 {
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
	if count != 5 {
		t.Fatalf("migration count after reopen = %d", count)
	}
}

func TestMigrateVaultUsernameOwnership(t *testing.T) {
	db, err := InitDB(filepath.Join(t.TempDir(), "xcontrol.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	for _, stmt := range []string{
		`INSERT INTO vault (id, type, data, name, username) VALUES ('key', 'private_key', 'x', 'key', 'root')`,
		`INSERT INTO vault (id, type, data, name, username) VALUES ('password', 'password', 'x', 'password', ' admin ')`,
		`INSERT INTO vault (id, type, data, name, username) VALUES ('inferred', 'password', 'x', 'inferred', '')`,
		`INSERT INTO vault (id, type, data, name, username) VALUES ('conflict', 'password', 'x', 'conflict', '')`,
		`INSERT INTO profiles (id, name, host, username, auth_type, vault_id) VALUES ('p1', 'p1', 'h', 'old', 'vault', 'password')`,
		`INSERT INTO profiles (id, name, host, username, auth_type, vault_id) VALUES ('p2', 'p2', 'h', 'deploy', 'vault', 'inferred')`,
		`INSERT INTO profiles (id, name, host, username, auth_type, vault_id) VALUES ('p3', 'p3', 'h', 'deploy', 'vault', 'inferred')`,
		`INSERT INTO profiles (id, name, host, username, auth_type, vault_id) VALUES ('p4', 'p4', 'h', 'root', 'vault', 'conflict')`,
		`INSERT INTO profiles (id, name, host, username, auth_type, vault_id) VALUES ('p5', 'p5', 'h', 'ubuntu', 'vault', 'conflict')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := migrateVaultUsernameOwnership(tx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	assertValue := func(query, want string) {
		t.Helper()
		var got string
		if err := db.QueryRow(query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("value = %q, want %q for %s", got, want, query)
		}
	}
	assertValue(`SELECT username FROM vault WHERE id = 'key'`, "")
	assertValue(`SELECT username FROM vault WHERE id = 'password'`, "admin")
	assertValue(`SELECT username FROM profiles WHERE id = 'p1'`, "admin")
	assertValue(`SELECT username FROM vault WHERE id = 'inferred'`, "deploy")
	assertValue(`SELECT username FROM vault WHERE id = 'conflict'`, "")
	assertValue(`SELECT username FROM profiles WHERE id = 'p4'`, "root")
}
