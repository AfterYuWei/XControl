package model

import "time"

type Group struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	ParentID  string    `json:"parent_id,omitempty"`
	Icon      string    `json:"icon"`
	SortOrder int       `json:"sort_order"`
	CreatedAt time.Time `json:"created_at"`
}

type GroupCreateRequest struct {
	Name     string `json:"name"`
	ParentID string `json:"parent_id,omitempty"`
	Icon     string `json:"icon,omitempty"`
}

type GroupUpdateRequest struct {
	Name     *string `json:"name,omitempty"`
	ParentID *string `json:"parent_id,omitempty"`
	Icon     *string `json:"icon,omitempty"`
}
