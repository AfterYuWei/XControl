// Package provider defines the cloud-storage abstraction shared by the sync
// manager and all concrete provider implementations. Kept in its own package
// to avoid an import cycle (sync ↔ providers).
package provider

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"
)

// ErrObjectNotFound is returned by GetObject/DeleteObject for missing keys.
var ErrObjectNotFound = errors.New("object not found")

// CloudIndex mirrors the index.json stored at each provider. It is the
// source of truth for "what does the cloud have" without listing objects.
type CloudIndex struct {
	Format        string             `json:"format"` // xcontrol-sync-index
	Version       int                `json:"version"`
	DeviceID      string             `json:"device_id"`
	LatestVersion int64              `json:"latest_version"`
	Versions      []CloudVersionInfo `json:"versions"`
	UpdatedAt     time.Time          `json:"updated_at"`
}

// CloudVersionInfo is one entry in the cloud index.
type CloudVersionInfo struct {
	Version   int64     `json:"version"`
	Hash      string    `json:"hash"`
	Size      int64     `json:"size"`
	Object    string    `json:"object"`
	CreatedAt time.Time `json:"created_at"`
}

const CloudIndexFormat = "xcontrol-sync-index"

// NewCloudIndex returns an empty index.
func NewCloudIndex() *CloudIndex {
	return &CloudIndex{
		Format:   CloudIndexFormat,
		Version:  1,
		Versions: []CloudVersionInfo{},
	}
}

// HashOf returns the hash recorded for a version, or "" if absent.
func (c *CloudIndex) HashOf(version int64) string {
	for _, v := range c.Versions {
		if v.Version == version {
			return v.Hash
		}
	}
	return ""
}

// ContainsHash reports whether any indexed version has this content hash.
func (c *CloudIndex) ContainsHash(hash string) bool {
	for _, v := range c.Versions {
		if v.Hash == hash {
			return true
		}
	}
	return false
}

// Latest returns the newest indexed version, or nil.
func (c *CloudIndex) Latest() *CloudVersionInfo {
	if len(c.Versions) == 0 {
		return nil
	}
	latest := &c.Versions[0]
	for i := range c.Versions {
		if c.Versions[i].Version > latest.Version {
			latest = &c.Versions[i]
		}
	}
	return latest
}

// Add appends a version and refreshes LatestVersion.
func (c *CloudIndex) Add(v CloudVersionInfo) {
	for i, existing := range c.Versions {
		if existing.Version == v.Version {
			c.Versions[i] = v
			c.recalc()
			return
		}
	}
	c.Versions = append(c.Versions, v)
	c.recalc()
}

// Remove drops a version from the index.
func (c *CloudIndex) Remove(version int64) {
	out := c.Versions[:0]
	for _, v := range c.Versions {
		if v.Version != version {
			out = append(out, v)
		}
	}
	c.Versions = out
	c.recalc()
}

func (c *CloudIndex) recalc() {
	c.LatestVersion = 0
	for _, v := range c.Versions {
		if v.Version > c.LatestVersion {
			c.LatestVersion = v.Version
		}
	}
	c.UpdatedAt = time.Now().UTC()
}

// Provider is the uniform abstraction over all cloud storage backends.
// Implementations must be safe for concurrent use.
type Provider interface {
	ID() string
	Type() string // webdav | s3 | gdrive | onedrive
	Name() string

	// Ping verifies connectivity & credentials.
	Ping(ctx context.Context) error

	// ReadIndex fetches index.json; returns an empty index when missing.
	ReadIndex(ctx context.Context) (*CloudIndex, error)
	// WriteIndex atomically replaces index.json.
	WriteIndex(ctx context.Context, idx *CloudIndex) error

	// PutObject uploads a version file (idempotent by name).
	PutObject(ctx context.Context, name string, r io.Reader, size int64) error
	// GetObject downloads a version file.
	GetObject(ctx context.Context, name string) (io.ReadCloser, error)
	// DeleteObject removes a version file; missing keys are not an error.
	DeleteObject(ctx context.Context, name string) error
}

// ObjectName builds the canonical object name for a version.
func ObjectName(version int64, hash string) string {
	return fmt.Sprintf("v%06d-%s.xcbackup", version, hash[:12])
}
