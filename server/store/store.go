package store

import "github.com/yuweinfo/sshx/model"

type ProfileStore interface {
	List(groupID string, search string) ([]*model.Profile, error)
	Get(id string) (*model.Profile, error)
	Create(p *model.Profile) error
	Update(id string, p *model.ProfileUpdateRequest) error
	Delete(id string) error
	UpdateLastUsed(id string) error
}

type GroupStore interface {
	List() ([]*model.Group, error)
	Get(id string) (*model.Group, error)
	Create(g *model.Group) error
	Update(id string, g *model.GroupUpdateRequest) error
	Delete(id string) error
}

type VaultStore interface {
	Store(cred *model.Credential, credType string) (string, error)
	Retrieve(id string) (*model.Credential, error)
	Delete(id string) error
	RefCount(id string) (int, error)
}

type SnippetStore interface {
	List() ([]*model.Snippet, error)
	Get(id string) (*model.Snippet, error)
	Create(s *model.Snippet) error
	Update(id string, s *model.SnippetUpdateRequest) error
	Delete(id string) error
}

type AuditStore interface {
	Log(entry *model.AuditLog) error
	List(profileID string, limit int) ([]*model.AuditLog, error)
}
