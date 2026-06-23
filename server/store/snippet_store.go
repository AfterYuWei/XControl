package store

import (
	"database/sql"
	"encoding/json"
	"time"

	"github.com/yuweinfo/sshx/model"
)

type sqliteSnippetStore struct {
	db *sql.DB
}

func NewSnippetStore(db *sql.DB) SnippetStore {
	return &sqliteSnippetStore{db: db}
}

func (s *sqliteSnippetStore) List() ([]*model.Snippet, error) {
	rows, err := s.db.Query(`SELECT id, name, content, description, tags, is_global, created_at, updated_at FROM snippets ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	snippets := make([]*model.Snippet, 0)
	for rows.Next() {
		sn := &model.Snippet{}
		var tagsJSON string
		var isGlobal int
		err := rows.Scan(&sn.ID, &sn.Name, &sn.Content, &sn.Description, &tagsJSON, &isGlobal, &sn.CreatedAt, &sn.UpdatedAt)
		if err != nil {
			return nil, err
		}
		json.Unmarshal([]byte(tagsJSON), &sn.Tags)
		if sn.Tags == nil {
			sn.Tags = []string{}
		}
		sn.IsGlobal = isGlobal == 1
		snippets = append(snippets, sn)
	}
	return snippets, nil
}

func (s *sqliteSnippetStore) Get(id string) (*model.Snippet, error) {
	sn := &model.Snippet{}
	var tagsJSON string
	var isGlobal int
	err := s.db.QueryRow(`SELECT id, name, content, description, tags, is_global, created_at, updated_at FROM snippets WHERE id = ?`, id).
		Scan(&sn.ID, &sn.Name, &sn.Content, &sn.Description, &tagsJSON, &isGlobal, &sn.CreatedAt, &sn.UpdatedAt)
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(tagsJSON), &sn.Tags)
	sn.IsGlobal = isGlobal == 1
	return sn, nil
}

func (s *sqliteSnippetStore) Create(sn *model.Snippet) error {
	tagsJSON, _ := json.Marshal(sn.Tags)
	isGlobal := 0
	if sn.IsGlobal {
		isGlobal = 1
	}
	_, err := s.db.Exec(`INSERT INTO snippets (id, name, content, description, tags, is_global, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sn.ID, sn.Name, sn.Content, sn.Description, string(tagsJSON), isGlobal, sn.CreatedAt, sn.UpdatedAt)
	return err
}

func (s *sqliteSnippetStore) Update(id string, req *model.SnippetUpdateRequest) error {
	sn, err := s.Get(id)
	if err != nil {
		return err
	}
	if req.Name != nil {
		sn.Name = *req.Name
	}
	if req.Content != nil {
		sn.Content = *req.Content
	}
	if req.Description != nil {
		sn.Description = *req.Description
	}
	if req.Tags != nil {
		sn.Tags = req.Tags
	}
	if req.IsGlobal != nil {
		sn.IsGlobal = *req.IsGlobal
	}
	sn.UpdatedAt = time.Now()

	tagsJSON, _ := json.Marshal(sn.Tags)
	isGlobal := 0
	if sn.IsGlobal {
		isGlobal = 1
	}
	_, err = s.db.Exec(`UPDATE snippets SET name=?, content=?, description=?, tags=?, is_global=?, updated_at=? WHERE id=?`,
		sn.Name, sn.Content, sn.Description, string(tagsJSON), isGlobal, sn.UpdatedAt, id)
	return err
}

func (s *sqliteSnippetStore) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM snippets WHERE id = ?`, id)
	return err
}
