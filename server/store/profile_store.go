package store

import (
	"database/sql"
	"encoding/json"
	"time"

	"github.com/yuweinfo/sshx/model"
)

type sqliteProfileStore struct {
	db *sql.DB
}

func NewProfileStore(db *sql.DB) ProfileStore {
	return &sqliteProfileStore{db: db}
}

func (s *sqliteProfileStore) List(groupID, search string) ([]*model.Profile, error) {
	query := `SELECT id, name, host, port, username, auth_type, vault_id, group_id, tags, options, note, sort_order, last_used_at, created_at, updated_at FROM profiles WHERE 1=1`
	args := []any{}

	if groupID != "" {
		query += ` AND group_id = ?`
		args = append(args, groupID)
	}
	if search != "" {
		query += ` AND (name LIKE ? OR host LIKE ? OR note LIKE ?)`
		q := "%" + search + "%"
		args = append(args, q, q, q)
	}

	query += ` ORDER BY sort_order, name`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	profiles := make([]*model.Profile, 0)
	for rows.Next() {
		p := &model.Profile{}
		var tagsJSON string
		var lastUsed sql.NullTime
		err := rows.Scan(&p.ID, &p.Name, &p.Host, &p.Port, &p.Username, &p.AuthType, &p.VaultID, &p.GroupID, &tagsJSON, &p.Options, &p.Note, &p.SortOrder, &lastUsed, &p.CreatedAt, &p.UpdatedAt)
		if err != nil {
			return nil, err
		}
		json.Unmarshal([]byte(tagsJSON), &p.Tags)
		if p.Tags == nil {
			p.Tags = []string{}
		}
		if lastUsed.Valid {
			p.LastUsedAt = &lastUsed.Time
		}
		profiles = append(profiles, p)
	}
	return profiles, nil
}

func (s *sqliteProfileStore) Get(id string) (*model.Profile, error) {
	p := &model.Profile{}
	var tagsJSON string
	var lastUsed sql.NullTime
	err := s.db.QueryRow(`SELECT id, name, host, port, username, auth_type, vault_id, group_id, tags, options, note, sort_order, last_used_at, created_at, updated_at FROM profiles WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Host, &p.Port, &p.Username, &p.AuthType, &p.VaultID, &p.GroupID, &tagsJSON, &p.Options, &p.Note, &p.SortOrder, &lastUsed, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(tagsJSON), &p.Tags)
	if p.Tags == nil {
		p.Tags = []string{}
	}
	if lastUsed.Valid {
		p.LastUsedAt = &lastUsed.Time
	}
	return p, nil
}

func (s *sqliteProfileStore) Create(p *model.Profile) error {
	tagsJSON, _ := json.Marshal(p.Tags)
	_, err := s.db.Exec(`INSERT INTO profiles (id, name, host, port, username, auth_type, vault_id, group_id, tags, options, note, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.Host, p.Port, p.Username, p.AuthType, p.VaultID, p.GroupID, string(tagsJSON), p.Options, p.Note, p.SortOrder, p.CreatedAt, p.UpdatedAt)
	return err
}

func (s *sqliteProfileStore) Update(id string, req *model.ProfileUpdateRequest) error {
	p, err := s.Get(id)
	if err != nil {
		return err
	}

	if req.Name != nil {
		p.Name = *req.Name
	}
	if req.Host != nil {
		p.Host = *req.Host
	}
	if req.Port != nil {
		p.Port = *req.Port
	}
	if req.Username != nil {
		p.Username = *req.Username
	}
	if req.AuthType != nil {
		p.AuthType = *req.AuthType
	}
	if req.VaultID != nil {
		p.VaultID = *req.VaultID
	}
	if req.GroupID != nil {
		p.GroupID = *req.GroupID
	}
	if req.Tags != nil {
		p.Tags = req.Tags
	}
	if req.Options != nil {
		p.Options = *req.Options
	}
	if req.Note != nil {
		p.Note = *req.Note
	}
	p.UpdatedAt = time.Now()

	tagsJSON, _ := json.Marshal(p.Tags)
	_, err = s.db.Exec(`UPDATE profiles SET name=?, host=?, port=?, username=?, auth_type=?, vault_id=?, group_id=?, tags=?, options=?, note=?, updated_at=? WHERE id=?`,
		p.Name, p.Host, p.Port, p.Username, p.AuthType, p.VaultID, p.GroupID, string(tagsJSON), p.Options, p.Note, p.UpdatedAt, id)
	return err
}

func (s *sqliteProfileStore) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM profiles WHERE id = ?`, id)
	return err
}

func (s *sqliteProfileStore) UpdateLastUsed(id string) error {
	_, err := s.db.Exec(`UPDATE profiles SET last_used_at = ? WHERE id = ?`, time.Now(), id)
	return err
}
