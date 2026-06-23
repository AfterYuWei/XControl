package model

import "time"

type AuditLog struct {
	ID        string    `json:"id"`
	ProfileID string    `json:"profile_id,omitempty"`
	Action    string    `json:"action"` // connect | disconnect | command
	Detail    string    `json:"detail,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}
