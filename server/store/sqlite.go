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

	db.SetMaxOpenConns(1)

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return db, nil
}

func migrate(db *sql.DB) error {
	migrations := []string{
		`CREATE TABLE IF NOT EXISTS groups (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			parent_id  TEXT REFERENCES groups(id) ON DELETE SET NULL,
			icon       TEXT DEFAULT '📁',
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
	}

	for _, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			return fmt.Errorf("exec migration: %w\nSQL: %s", err, m)
		}
	}

	return nil
}
