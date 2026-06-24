package fileutil

import "errors"

// Sentinel errors that backends map to for consistent HTTP error handling.
var (
	ErrNotFound      = errors.New("path not found")
	ErrPermission    = errors.New("permission denied")
	ErrAlreadyExists = errors.New("path already exists")
	ErrNotConnected  = errors.New("backend not connected")
)
