package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func InitDB(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	// A desktop process owns one SQLite database. Keeping a single live
	// connection preserves connection-scoped pragmas and serializes writes.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	for _, pragma := range []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA busy_timeout = 5000`,
		`PRAGMA journal_mode = WAL`,
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("configure sqlite (%s): %w", pragma, err)
		}
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return db, nil
}

func migrate(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	migrations := []struct {
		version int
		apply   func(*sql.Tx) error
	}{
		{version: 1, apply: migrateCoreSchema},
		{version: 2, apply: migrateCredentialMetadata},
		{version: 3, apply: migrateSyncSchema},
		{version: 4, apply: migrateVaultUsernameOwnership},
		{version: 5, apply: migrateProfileProxyCredentials},
	}

	for _, migration := range migrations {
		if err := applyMigration(db, migration.version, migration.apply); err != nil {
			return err
		}
	}
	return nil
}

func migrateProfileProxyCredentials(tx *sql.Tx) error {
	return addColumnIfMissing(tx, "profiles", "proxy_credential", "TEXT DEFAULT ''")
}

func applyMigration(db *sql.DB, version int, apply func(*sql.Tx) error) error {
	var applied bool
	if err := db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`,
		version,
	).Scan(&applied); err != nil {
		return fmt.Errorf("check migration %d: %w", version, err)
	}
	if applied {
		return nil
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin migration %d: %w", version, err)
	}
	defer tx.Rollback()

	if err := apply(tx); err != nil {
		return fmt.Errorf("apply migration %d: %w", version, err)
	}
	if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, version); err != nil {
		return fmt.Errorf("record migration %d: %w", version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %d: %w", version, err)
	}
	return nil
}

func migrateCoreSchema(tx *sql.Tx) error {
	return execStatements(tx, []string{
		`CREATE TABLE IF NOT EXISTS groups (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			parent_id  TEXT REFERENCES groups(id) ON DELETE SET NULL,
			icon       TEXT DEFAULT 'folder',
			sort_order INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS vault (
			id          TEXT PRIMARY KEY,
			type        TEXT NOT NULL,
			data        TEXT NOT NULL,
			fingerprint TEXT DEFAULT '',
			created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS profiles (
			id           TEXT PRIMARY KEY,
			name         TEXT NOT NULL,
			host         TEXT NOT NULL,
			port         INTEGER NOT NULL DEFAULT 22,
			username     TEXT NOT NULL DEFAULT 'root',
			auth_type    TEXT NOT NULL DEFAULT 'password',
			vault_id     TEXT DEFAULT '',
			group_id     TEXT DEFAULT '',
			tags         TEXT DEFAULT '[]',
			options      TEXT DEFAULT '{}',
			note         TEXT DEFAULT '',
			sort_order   INTEGER DEFAULT 0,
			last_used_at DATETIME,
			created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS snippets (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			content     TEXT NOT NULL,
			description TEXT DEFAULT '',
			tags        TEXT DEFAULT '[]',
			is_global   INTEGER DEFAULT 1,
			created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS audit_logs (
			id         TEXT PRIMARY KEY,
			profile_id TEXT DEFAULT '',
			action     TEXT NOT NULL,
			detail     TEXT DEFAULT '',
			timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(group_id)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_profile ON audit_logs(profile_id)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(timestamp)`,
	})
}

func migrateCredentialMetadata(tx *sql.Tx) error {
	columns := []struct {
		table  string
		column string
		def    string
	}{
		{"profiles", "icon", "TEXT DEFAULT ''"},
		{"profiles", "inline_credential", "TEXT DEFAULT ''"},
		{"vault", "name", "TEXT NOT NULL DEFAULT ''"},
		{"vault", "remark", "TEXT DEFAULT ''"},
		{"vault", "updated_at", "DATETIME"},
		{"vault", "username", "TEXT DEFAULT ''"},
	}
	for _, column := range columns {
		if err := addColumnIfMissing(tx, column.table, column.column, column.def); err != nil {
			return fmt.Errorf("add %s.%s: %w", column.table, column.column, err)
		}
	}
	if _, err := tx.Exec(`UPDATE vault SET updated_at = created_at WHERE updated_at IS NULL`); err != nil {
		return fmt.Errorf("backfill vault.updated_at: %w", err)
	}
	return nil
}

func migrateSyncSchema(tx *sql.Tx) error {
	return execStatements(tx, []string{
		`CREATE TABLE IF NOT EXISTS sync_versions (
			id         TEXT PRIMARY KEY,
			version    INTEGER NOT NULL UNIQUE,
			hash       TEXT NOT NULL,
			size       INTEGER NOT NULL,
			file_path  TEXT NOT NULL,
			origin     TEXT NOT NULL,
			synced_to  TEXT NOT NULL DEFAULT '[]',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sync_versions_ver ON sync_versions(version DESC)`,
		`CREATE TABLE IF NOT EXISTS sync_providers (
			id         TEXT PRIMARY KEY,
			type       TEXT NOT NULL,
			name       TEXT NOT NULL,
			enabled    INTEGER NOT NULL DEFAULT 1,
			config     TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS sync_state (
			id            INTEGER PRIMARY KEY CHECK (id = 1),
			next_version  INTEGER NOT NULL DEFAULT 1,
			last_sync_at  DATETIME,
			status        TEXT NOT NULL DEFAULT 'idle',
			conflict_json TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS sync_settings (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sync_events (
			id          TEXT PRIMARY KEY,
			provider_id TEXT NOT NULL DEFAULT '',
			action      TEXT NOT NULL,
			version     INTEGER NOT NULL DEFAULT 0,
			success     INTEGER NOT NULL,
			error       TEXT NOT NULL DEFAULT '',
			created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sync_events_time ON sync_events(created_at DESC)`,
		`INSERT OR IGNORE INTO sync_state (id, next_version, status) VALUES (1, 1, 'idle')`,
	})
}

// migrateVaultUsernameOwnership makes login usernames password-specific in
// Vault. Reusable keys no longer own a username; profiles always keep the
// effective SSH login user.
func migrateVaultUsernameOwnership(tx *sql.Tx) error {
	return normalizeVaultUsernameReferences(tx)
}

func normalizeVaultUsernameReferences(executor sqlExecutor) error {
	return execStatements(executor, []string{
		`UPDATE vault SET username = '' WHERE type != 'password' AND username != ''`,
		`UPDATE vault SET username = TRIM(username) WHERE type = 'password'`,
		`UPDATE vault
		 SET username = (
			 SELECT MIN(TRIM(p.username))
			 FROM profiles p
			 WHERE p.auth_type = 'vault'
			   AND p.vault_id = vault.id
			   AND TRIM(p.username) != ''
		 )
		 WHERE type = 'password'
		   AND TRIM(username) = ''
		   AND (
			 SELECT COUNT(DISTINCT TRIM(p.username))
			 FROM profiles p
			 WHERE p.auth_type = 'vault'
			   AND p.vault_id = vault.id
			   AND TRIM(p.username) != ''
		   ) = 1`,
		`UPDATE profiles
		 SET username = (
			 SELECT v.username FROM vault v WHERE v.id = profiles.vault_id
		 ),
		 updated_at = CURRENT_TIMESTAMP
		 WHERE auth_type = 'vault'
		   AND EXISTS (
			 SELECT 1 FROM vault v
			 WHERE v.id = profiles.vault_id
			   AND v.type = 'password'
			   AND TRIM(v.username) != ''
			   AND profiles.username != v.username
		   )`,
	})
}

type sqlExecutor interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
}

func execStatements(executor sqlExecutor, statements []string) error {
	for _, statement := range statements {
		if _, err := executor.Exec(statement); err != nil {
			return fmt.Errorf("exec migration statement: %w\nSQL: %s", err, statement)
		}
	}
	return nil
}

// addColumnIfMissing runs ALTER TABLE only when the column does not exist.
func addColumnIfMissing(executor sqlExecutor, table, column, def string) error {
	rows, err := executor.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = executor.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, def))
	return err
}
