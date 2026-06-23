package model

import "time"

type Snippet struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Content     string    `json:"content"`
	Description string    `json:"description,omitempty"`
	Tags        []string  `json:"tags"`
	IsGlobal    bool      `json:"is_global"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type SnippetCreateRequest struct {
	Name        string   `json:"name"`
	Content     string   `json:"content"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	IsGlobal    *bool    `json:"is_global,omitempty"`
}

type SnippetUpdateRequest struct {
	Name        *string  `json:"name,omitempty"`
	Content     *string  `json:"content,omitempty"`
	Description *string  `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	IsGlobal    *bool    `json:"is_global,omitempty"`
}
