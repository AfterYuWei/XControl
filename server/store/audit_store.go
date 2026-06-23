package store

import (
	"database/sql"

	"github.com/yuweinfo/sshx/model"
)

type sqliteAuditStore struct {
	db *sql.DB
}

func NewAuditStore(db *sql.DB) AuditStore {
	return &sqliteAuditStore{db: db}
}

func (s *sqliteAuditStore) Log(entry *model.AuditLog) error {
	_, err := s.db.Exec(`INSERT INTO audit_logs (id, profile_id, action, detail, timestamp) VALUES (?, ?, ?, ?, ?)`,
		entry.ID, entry.ProfileID, entry.Action, entry.Detail, entry.Timestamp)
	return err
}

func (s *sqliteAuditStore) List(profileID string, limit int) ([]*model.AuditLog, error) {
	if limit <= 0 {
		limit = 100
	}
	query := `SELECT id, profile_id, action, detail, timestamp FROM audit_logs`
	args := []any{}
	if profileID != "" {
		query += ` WHERE profile_id = ?`
		args = append(args, profileID)
	}
	query += ` ORDER BY timestamp DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	logs := make([]*model.AuditLog, 0)
	for rows.Next() {
		l := &model.AuditLog{}
		if err := rows.Scan(&l.ID, &l.ProfileID, &l.Action, &l.Detail, &l.Timestamp); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}
