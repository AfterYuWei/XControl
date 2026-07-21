package store

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
)

// BackupStore handles full-database export and import for the backup feature.
// It reads/writes rows directly (instead of reusing the per-resource stores)
// so that both operations run inside a single transaction and can access the
// encrypted columns.
type BackupStore struct {
	db        *sql.DB
	encryptor *crypto.Encryptor
}

func NewBackupStore(db *sql.DB, encryptor *crypto.Encryptor) *BackupStore {
	return &BackupStore{db: db, encryptor: encryptor}
}

// Export reads all business data in one read transaction, with credentials
// decrypted into plaintext (the handler decides how to protect them).
func (s *BackupStore) Export() (*model.BackupPayload, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	payload := &model.BackupPayload{
		Groups:   []*model.Group{},
		Vault:    []*model.BackupVaultItem{},
		Profiles: []*model.BackupProfile{},
		Snippets: []*model.Snippet{},
	}

	if err := s.exportGroups(tx, payload); err != nil {
		return nil, err
	}
	if err := s.exportVault(tx, payload); err != nil {
		return nil, err
	}
	if err := s.exportProfiles(tx, payload); err != nil {
		return nil, err
	}
	if err := s.exportSnippets(tx, payload); err != nil {
		return nil, err
	}

	return payload, tx.Commit()
}

func (s *BackupStore) exportGroups(tx *sql.Tx, p *model.BackupPayload) error {
	rows, err := tx.Query(`SELECT id, name, parent_id, icon, sort_order, created_at FROM groups ORDER BY sort_order, name`)
	if err != nil {
		return fmt.Errorf("export groups: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		g := &model.Group{}
		var parentID sql.NullString
		if err := rows.Scan(&g.ID, &g.Name, &parentID, &g.Icon, &g.SortOrder, &g.CreatedAt); err != nil {
			return err
		}
		if parentID.Valid {
			g.ParentID = parentID.String
		}
		p.Groups = append(p.Groups, g)
	}
	return rows.Err()
}

func (s *BackupStore) exportVault(tx *sql.Tx, p *model.BackupPayload) error {
	rows, err := tx.Query(`SELECT id, type, data, name, username, remark, fingerprint, created_at, updated_at FROM vault ORDER BY created_at`)
	if err != nil {
		return fmt.Errorf("export vault: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			item      model.BackupVaultItem
			data      string
			updatedAt sql.NullTime
		)
		if err := rows.Scan(&item.ID, &item.Type, &data, &item.Name, &item.Username, &item.Remark, &item.Fingerprint, &item.CreatedAt, &updatedAt); err != nil {
			return err
		}
		item.UpdatedAt = item.CreatedAt
		if updatedAt.Valid {
			item.UpdatedAt = updatedAt.Time
		}
		decrypted, err := s.encryptor.Decrypt(data)
		if err != nil {
			return fmt.Errorf("decrypt vault %s: %w", item.ID, err)
		}
		item.Credential = decodePlaintext(decrypted, item.Type)
		p.Vault = append(p.Vault, &item)
	}
	return rows.Err()
}

func (s *BackupStore) exportProfiles(tx *sql.Tx, p *model.BackupPayload) error {
	rows, err := tx.Query(`SELECT id, name, host, port, username, auth_type, icon, vault_id, inline_credential, group_id, tags, options, note, sort_order, created_at, updated_at FROM profiles ORDER BY sort_order, name`)
	if err != nil {
		return fmt.Errorf("export profiles: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			item    model.BackupProfile
			inline  string
			tagsJSON string
		)
		if err := rows.Scan(&item.ID, &item.Name, &item.Host, &item.Port, &item.Username, &item.AuthType, &item.Icon, &item.VaultID, &inline, &item.GroupID, &tagsJSON, &item.Options, &item.Note, &item.SortOrder, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return err
		}
		json.Unmarshal([]byte(tagsJSON), &item.Tags)
		if item.Tags == nil {
			item.Tags = []string{}
		}
		if inline != "" {
			cred, err := DecodeInlineCredential(s.encryptor, inline)
			if err != nil {
				return fmt.Errorf("decode inline credential for profile %s: %w", item.ID, err)
			}
			item.InlineCredential = cred
		}
		p.Profiles = append(p.Profiles, &item)
	}
	return rows.Err()
}

func (s *BackupStore) exportSnippets(tx *sql.Tx, p *model.BackupPayload) error {
	rows, err := tx.Query(`SELECT id, name, content, description, tags, is_global, created_at, updated_at FROM snippets ORDER BY name`)
	if err != nil {
		return fmt.Errorf("export snippets: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		sn := &model.Snippet{}
		var (
			tagsJSON string
			isGlobal int
		)
		if err := rows.Scan(&sn.ID, &sn.Name, &sn.Content, &sn.Description, &tagsJSON, &isGlobal, &sn.CreatedAt, &sn.UpdatedAt); err != nil {
			return err
		}
		json.Unmarshal([]byte(tagsJSON), &sn.Tags)
		if sn.Tags == nil {
			sn.Tags = []string{}
		}
		sn.IsGlobal = isGlobal == 1
		p.Snippets = append(p.Snippets, sn)
	}
	return rows.Err()
}

// Conflicts counts how many backup records already exist in the DB (by id).
func (s *BackupStore) Conflicts(p *model.BackupPayload) (*model.BackupStats, error) {
	countIDs := func(table string, ids []string) (int, error) {
		n := 0
		for _, id := range ids {
			var exists int
			if err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM `+table+` WHERE id = ?)`, id).Scan(&exists); err != nil {
				return 0, err
			}
			if exists == 1 {
				n++
			}
		}
		return n, nil
	}

	stats := &model.BackupStats{}
	var err error

	ids := make([]string, 0, len(p.Groups))
	for _, g := range p.Groups {
		ids = append(ids, g.ID)
	}
	if stats.Groups, err = countIDs("groups", ids); err != nil {
		return nil, err
	}

	ids = ids[:0]
	for _, v := range p.Vault {
		ids = append(ids, v.ID)
	}
	if stats.Vault, err = countIDs("vault", ids); err != nil {
		return nil, err
	}

	ids = ids[:0]
	for _, pr := range p.Profiles {
		ids = append(ids, pr.ID)
	}
	if stats.Profiles, err = countIDs("profiles", ids); err != nil {
		return nil, err
	}

	ids = ids[:0]
	for _, sn := range p.Snippets {
		ids = append(ids, sn.ID)
	}
	if stats.Snippets, err = countIDs("snippets", ids); err != nil {
		return nil, err
	}

	return stats, nil
}

// Import writes the backup payload into the DB in one transaction according
// to the merge strategy.
func (s *BackupStore) Import(p *model.BackupPayload, strategy string) (*model.BackupImportResult, error) {
	switch strategy {
	case model.BackupStrategySkip, model.BackupStrategyOverwrite, model.BackupStrategyRegenerate:
	default:
		return nil, fmt.Errorf("unknown import strategy: %s", strategy)
	}

	if strategy == model.BackupStrategyRegenerate {
		remapIDs(p)
	}

	// Groups must be written parent-first to satisfy the parent_id FK.
	orderedGroups, err := topoSortGroups(p.Groups)
	if err != nil {
		return nil, err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	result := &model.BackupImportResult{}

	for _, g := range orderedGroups {
		action, err := s.importGroup(tx, g, strategy)
		if err != nil {
			return nil, fmt.Errorf("import group %s: %w", g.ID, err)
		}
		addStat(result, action, func(r *model.BackupStats) *int { return &r.Groups })
	}
	for _, v := range p.Vault {
		action, err := s.importVault(tx, v, strategy)
		if err != nil {
			return nil, fmt.Errorf("import vault %s: %w", v.ID, err)
		}
		addStat(result, action, func(r *model.BackupStats) *int { return &r.Vault })
	}
	for _, pr := range p.Profiles {
		action, err := s.importProfile(tx, pr, strategy)
		if err != nil {
			return nil, fmt.Errorf("import profile %s: %w", pr.ID, err)
		}
		addStat(result, action, func(r *model.BackupStats) *int { return &r.Profiles })
	}
	for _, sn := range p.Snippets {
		action, err := s.importSnippet(tx, sn, strategy)
		if err != nil {
			return nil, fmt.Errorf("import snippet %s: %w", sn.ID, err)
		}
		addStat(result, action, func(r *model.BackupStats) *int { return &r.Snippets })
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

type importAction int

const (
	actionSkipped importAction = iota
	actionImported
)

func addStat(result *model.BackupImportResult, action importAction, field func(*model.BackupStats) *int) {
	if action == actionSkipped {
		*field(&result.Skipped)++
	} else {
		*field(&result.Imported)++
	}
}

func existsInTx(tx *sql.Tx, table, id string) (bool, error) {
	var exists int
	err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM `+table+` WHERE id = ?)`, id).Scan(&exists)
	return exists == 1, err
}

func (s *BackupStore) importGroup(tx *sql.Tx, g *model.Group, strategy string) (importAction, error) {
	if strategy == model.BackupStrategySkip {
		exists, err := existsInTx(tx, "groups", g.ID)
		if err != nil {
			return actionSkipped, err
		}
		if exists {
			return actionSkipped, nil
		}
	}
	verb := "INSERT"
	if strategy == model.BackupStrategyOverwrite {
		verb = "INSERT OR REPLACE"
	}
	_, err := tx.Exec(verb+` INTO groups (id, name, parent_id, icon, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		g.ID, g.Name, nullStr(g.ParentID), g.Icon, g.SortOrder, g.CreatedAt)
	return actionImported, err
}

func (s *BackupStore) importVault(tx *sql.Tx, v *model.BackupVaultItem, strategy string) (importAction, error) {
	if strategy == model.BackupStrategySkip {
		exists, err := existsInTx(tx, "vault", v.ID)
		if err != nil {
			return actionSkipped, err
		}
		if exists {
			return actionSkipped, nil
		}
	}
	if v.Credential == nil {
		return actionSkipped, fmt.Errorf("vault item %s has no credential", v.ID)
	}
	plaintext, fingerprint, err := encodePlaintext(v.Credential, v.Type)
	if err != nil {
		return actionSkipped, err
	}
	encrypted, err := s.encryptor.Encrypt(plaintext)
	if err != nil {
		return actionSkipped, err
	}
	verb := "INSERT"
	if strategy == model.BackupStrategyOverwrite {
		verb = "INSERT OR REPLACE"
	}
	_, err = tx.Exec(verb+` INTO vault (id, type, data, fingerprint, name, username, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.ID, v.Type, encrypted, fingerprint, v.Name, v.Username, v.Remark, v.CreatedAt, v.UpdatedAt)
	return actionImported, err
}

func (s *BackupStore) importProfile(tx *sql.Tx, p *model.BackupProfile, strategy string) (importAction, error) {
	if strategy == model.BackupStrategySkip {
		exists, err := existsInTx(tx, "profiles", p.ID)
		if err != nil {
			return actionSkipped, err
		}
		if exists {
			return actionSkipped, nil
		}
	}
	inline, err := EncodeInlineCredential(s.encryptor, p.InlineCredential)
	if err != nil {
		return actionSkipped, err
	}
	tagsJSON, _ := json.Marshal(p.Tags)
	verb := "INSERT"
	if strategy == model.BackupStrategyOverwrite {
		verb = "INSERT OR REPLACE"
	}
	_, err = tx.Exec(verb+` INTO profiles (id, name, host, port, username, auth_type, icon, vault_id, inline_credential, group_id, tags, options, note, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.Host, p.Port, p.Username, p.AuthType, p.Icon, p.VaultID, inline, p.GroupID, string(tagsJSON), p.Options, p.Note, p.SortOrder, p.CreatedAt, p.UpdatedAt)
	return actionImported, err
}

func (s *BackupStore) importSnippet(tx *sql.Tx, sn *model.Snippet, strategy string) (importAction, error) {
	if strategy == model.BackupStrategySkip {
		exists, err := existsInTx(tx, "snippets", sn.ID)
		if err != nil {
			return actionSkipped, err
		}
		if exists {
			return actionSkipped, nil
		}
	}
	tagsJSON, _ := json.Marshal(sn.Tags)
	isGlobal := 0
	if sn.IsGlobal {
		isGlobal = 1
	}
	verb := "INSERT"
	if strategy == model.BackupStrategyOverwrite {
		verb = "INSERT OR REPLACE"
	}
	_, err := tx.Exec(verb+` INTO snippets (id, name, content, description, tags, is_global, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sn.ID, sn.Name, sn.Content, sn.Description, string(tagsJSON), isGlobal, sn.CreatedAt, sn.UpdatedAt)
	return actionImported, err
}

// remapIDs assigns fresh UUIDs to every record and rewrites all internal
// references (groups.parent_id, profiles.group_id, profiles.vault_id).
func remapIDs(p *model.BackupPayload) {
	idMap := map[string]string{}
	remap := func(old string) string {
		if old == "" {
			return ""
		}
		if mapped, ok := idMap[old]; ok {
			return mapped
		}
		// Reference to a record not included in the backup: keep as-is so it
		// still resolves if the target DB happens to have it.
		return old
	}

	for _, g := range p.Groups {
		idMap[g.ID] = uuid.NewString()
	}
	for _, v := range p.Vault {
		idMap[v.ID] = uuid.NewString()
	}
	for _, pr := range p.Profiles {
		idMap[pr.ID] = uuid.NewString()
	}
	for _, sn := range p.Snippets {
		idMap[sn.ID] = uuid.NewString()
	}

	for _, g := range p.Groups {
		g.ID = idMap[g.ID]
		g.ParentID = remap(g.ParentID)
	}
	for _, v := range p.Vault {
		v.ID = idMap[v.ID]
	}
	for _, pr := range p.Profiles {
		pr.ID = idMap[pr.ID]
		pr.GroupID = remap(pr.GroupID)
		pr.VaultID = remap(pr.VaultID)
	}
	for _, sn := range p.Snippets {
		sn.ID = idMap[sn.ID]
	}
}

// topoSortGroups orders groups so parents come before children. A cycle in
// parent references (possible in hand-crafted files) is rejected.
func topoSortGroups(groups []*model.Group) ([]*model.Group, error) {
	byID := make(map[string]*model.Group, len(groups))
	for _, g := range groups {
		byID[g.ID] = g
	}
	const (
		unvisited = 0
		inStack   = 1
		done      = 2
	)
	state := make(map[string]int, len(groups))
	ordered := make([]*model.Group, 0, len(groups))

	var visit func(g *model.Group) error
	visit = func(g *model.Group) error {
		switch state[g.ID] {
		case done:
			return nil
		case inStack:
			return fmt.Errorf("分组存在循环引用（group %s）", g.ID)
		}
		state[g.ID] = inStack
		if g.ParentID != "" {
			if parent, ok := byID[g.ParentID]; ok {
				if err := visit(parent); err != nil {
					return err
				}
			}
		}
		state[g.ID] = done
		ordered = append(ordered, g)
		return nil
	}

	for _, g := range groups {
		if err := visit(g); err != nil {
			return nil, err
		}
	}
	return ordered, nil
}
