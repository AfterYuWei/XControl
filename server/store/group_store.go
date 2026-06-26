package store

import (
	"database/sql"

	"github.com/yuweinfo/xcontrol/model"
)

type sqliteGroupStore struct {
	db *sql.DB
}

func NewGroupStore(db *sql.DB) GroupStore {
	return &sqliteGroupStore{db: db}
}

func (s *sqliteGroupStore) List() ([]*model.Group, error) {
	rows, err := s.db.Query(`SELECT id, name, parent_id, icon, sort_order, created_at FROM groups ORDER BY sort_order, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := make([]*model.Group, 0)
	for rows.Next() {
		g := &model.Group{}
		var parentID sql.NullString
		err := rows.Scan(&g.ID, &g.Name, &parentID, &g.Icon, &g.SortOrder, &g.CreatedAt)
		if err != nil {
			return nil, err
		}
		if parentID.Valid {
			g.ParentID = parentID.String
		}
		groups = append(groups, g)
	}
	return groups, nil
}

func (s *sqliteGroupStore) Get(id string) (*model.Group, error) {
	g := &model.Group{}
	var parentID sql.NullString
	err := s.db.QueryRow(`SELECT id, name, parent_id, icon, sort_order, created_at FROM groups WHERE id = ?`, id).
		Scan(&g.ID, &g.Name, &parentID, &g.Icon, &g.SortOrder, &g.CreatedAt)
	if err != nil {
		return nil, err
	}
	if parentID.Valid {
		g.ParentID = parentID.String
	}
	return g, nil
}

func (s *sqliteGroupStore) Create(g *model.Group) error {
	_, err := s.db.Exec(`INSERT INTO groups (id, name, parent_id, icon, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		g.ID, g.Name, nullStr(g.ParentID), g.Icon, g.SortOrder, g.CreatedAt)
	return err
}

func (s *sqliteGroupStore) Update(id string, req *model.GroupUpdateRequest) error {
	g, err := s.Get(id)
	if err != nil {
		return err
	}
	if req.Name != nil {
		g.Name = *req.Name
	}
	if req.ParentID != nil {
		g.ParentID = *req.ParentID
	}
	if req.Icon != nil {
		g.Icon = *req.Icon
	}
	_, err = s.db.Exec(`UPDATE groups SET name=?, parent_id=?, icon=? WHERE id=?`,
		g.Name, nullStr(g.ParentID), g.Icon, id)
	return err
}

func (s *sqliteGroupStore) Delete(id string) error {
	_, err := s.db.Exec(`UPDATE groups SET parent_id = NULL WHERE parent_id = ?`, id)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`DELETE FROM groups WHERE id = ?`, id)
	return err
}

func nullStr(v string) sql.NullString {
	if v == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: v, Valid: true}
}
