package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"time"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/sync/provider"
)

const (
	gdriveAPI    = "https://www.googleapis.com/drive/v3"
	gdriveUpload = "https://www.googleapis.com/upload/drive/v3"
	gdriveFolder = "xcontrol-backups"
)

// TokenRefresher refreshes an expired OAuth token and returns the new one.
// The manager injects a persistence-aware implementation.
type TokenRefresher func(ctx context.Context) (accessToken string, err error)

// gdriveProvider implements Provider over the Google Drive REST API using
// plain net/http (keeps the binary free of the heavy google-api client).
type gdriveProvider struct {
	id          string
	name        string
	accessToken string
	folderID    string
	refresh     TokenRefresher
	persistCfg  func(mutate func(cfg *model.SyncProviderConfig)) error
	client      *http.Client
}

// NewGDrive builds a Google Drive provider.
func NewGDrive(
	id string,
	cfg *model.SyncProviderConfig,
	refresh TokenRefresher,
	persist func(mutate func(cfg *model.SyncProviderConfig)) error,
) provider.Provider {
	return &gdriveProvider{
		id:          id,
		name:        cfg.Name,
		accessToken: cfg.OAuthAccessToken,
		folderID:    cfg.DriveFolderID,
		refresh:     refresh,
		persistCfg:  persist,
		client:      &http.Client{Timeout: 60 * time.Second},
	}
}

func (p *gdriveProvider) ID() string   { return p.id }
func (p *gdriveProvider) Type() string { return "gdrive" }
func (p *gdriveProvider) Name() string { return p.name }

// call executes an authorized request, refreshing the token once on 401.
func (p *gdriveProvider) call(ctx context.Context, method, rawURL string, body io.Reader, contentType string) (*http.Response, error) {
	do := func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+p.accessToken)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		return p.client.Do(req)
	}
	resp, err := do()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized && p.refresh != nil {
		resp.Body.Close()
		token, rerr := p.refresh(ctx)
		if rerr != nil {
			return nil, fmt.Errorf("oauth token 刷新失败（请重新授权）: %w", rerr)
		}
		p.accessToken = token
		return do()
	}
	return resp, nil
}

// ensureFolder finds or creates the backup folder, persisting its id.
func (p *gdriveProvider) ensureFolder(ctx context.Context) (string, error) {
	if p.folderID != "" {
		return p.folderID, nil
	}
	q := url.Values{}
	q.Set("q", fmt.Sprintf("name='%s' and mimeType='application/vnd.google-apps.folder' and trashed=false", gdriveFolder))
	q.Set("fields", "files(id,name)")
	resp, err := p.call(ctx, http.MethodGet, gdriveAPI+"/files?"+q.Encode(), nil, "")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var list struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return "", err
	}
	if len(list.Files) > 0 {
		p.folderID = list.Files[0].ID
	} else {
		meta := map[string]any{
			"name":     gdriveFolder,
			"mimeType": "application/vnd.google-apps.folder",
		}
		raw, _ := json.Marshal(meta)
		cresp, err := p.call(ctx, http.MethodPost, gdriveAPI+"/files", bytes.NewReader(raw), "application/json")
		if err != nil {
			return "", err
		}
		defer cresp.Body.Close()
		var created struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(cresp.Body).Decode(&created); err != nil {
			return "", err
		}
		if created.ID == "" {
			return "", fmt.Errorf("创建 Drive 文件夹失败 (HTTP %d)", cresp.StatusCode)
		}
		p.folderID = created.ID
	}
	if p.persistCfg != nil {
		fid := p.folderID
		_ = p.persistCfg(func(cfg *model.SyncProviderConfig) { cfg.DriveFolderID = fid })
	}
	return p.folderID, nil
}

// findFile locates a file by name inside the backup folder.
func (p *gdriveProvider) findFile(ctx context.Context, folderID, name string) (string, error) {
	q := url.Values{}
	q.Set("q", fmt.Sprintf("name='%s' and '%s' in parents and trashed=false", name, folderID))
	q.Set("fields", "files(id)")
	resp, err := p.call(ctx, http.MethodGet, gdriveAPI+"/files?"+q.Encode(), nil, "")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var list struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return "", err
	}
	if len(list.Files) == 0 {
		return "", provider.ErrObjectNotFound
	}
	return list.Files[0].ID, nil
}

// uploadFile creates or updates a file (multipart for create, media for update).
func (p *gdriveProvider) uploadFile(ctx context.Context, folderID, name string, content []byte) error {
	existingID, findErr := p.findFile(ctx, folderID, name)

	if findErr == provider.ErrObjectNotFound {
		// Create: multipart/related with metadata + content.
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		metaPart, _ := mw.CreatePart(textproto.MIMEHeader{
			"Content-Type": {"application/json; charset=UTF-8"},
		})
		meta, _ := json.Marshal(map[string]any{"name": name, "parents": []string{folderID}})
		metaPart.Write(meta)
		contentPart, _ := mw.CreatePart(textproto.MIMEHeader{
			"Content-Type": {"application/octet-stream"},
		})
		contentPart.Write(content)
		mw.Close()

		resp, err := p.call(ctx, http.MethodPost, gdriveUpload+"/files?uploadType=multipart", &buf, "multipart/related; boundary="+mw.Boundary())
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			return fmt.Errorf("Drive 上传失败 (HTTP %d): %s", resp.StatusCode, string(body))
		}
		return nil
	}
	if findErr != nil {
		return findErr
	}

	// Update existing file content.
	resp, err := p.call(ctx, http.MethodPatch, gdriveUpload+"/files/"+existingID+"?uploadType=media", bytes.NewReader(content), "application/octet-stream")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("Drive 更新失败 (HTTP %d)", resp.StatusCode)
	}
	return nil
}

func (p *gdriveProvider) Ping(ctx context.Context) error {
	_, err := p.ensureFolder(ctx)
	return err
}

func (p *gdriveProvider) ReadIndex(ctx context.Context) (*provider.CloudIndex, error) {
	rc, err := p.GetObject(ctx, "index.json")
	if err != nil {
		if err == provider.ErrObjectNotFound {
			return provider.NewCloudIndex(), nil
		}
		return nil, err
	}
	defer rc.Close()
	var idx provider.CloudIndex
	if err := json.NewDecoder(rc).Decode(&idx); err != nil {
		return nil, fmt.Errorf("云端索引损坏: %w", err)
	}
	if idx.Versions == nil {
		idx.Versions = []provider.CloudVersionInfo{}
	}
	return &idx, nil
}

func (p *gdriveProvider) WriteIndex(ctx context.Context, idx *provider.CloudIndex) error {
	raw, err := json.Marshal(idx)
	if err != nil {
		return err
	}
	folderID, err := p.ensureFolder(ctx)
	if err != nil {
		return err
	}
	return p.uploadFile(ctx, folderID, "index.json", raw)
}

func (p *gdriveProvider) PutObject(ctx context.Context, name string, r io.Reader, size int64) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	folderID, err := p.ensureFolder(ctx)
	if err != nil {
		return err
	}
	return p.uploadFile(ctx, folderID, name, data)
}

func (p *gdriveProvider) GetObject(ctx context.Context, name string) (io.ReadCloser, error) {
	folderID, err := p.ensureFolder(ctx)
	if err != nil {
		return nil, err
	}
	fileID, err := p.findFile(ctx, folderID, name)
	if err != nil {
		return nil, err
	}
	resp, err := p.call(ctx, http.MethodGet, gdriveAPI+"/files/"+fileID+"?alt=media", nil, "")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		resp.Body.Close()
		return nil, fmt.Errorf("Drive 下载失败 (HTTP %d)", resp.StatusCode)
	}
	return resp.Body, nil
}

func (p *gdriveProvider) DeleteObject(ctx context.Context, name string) error {
	folderID, err := p.ensureFolder(ctx)
	if err != nil {
		return err
	}
	fileID, err := p.findFile(ctx, folderID, name)
	if err != nil {
		if err == provider.ErrObjectNotFound {
			return nil
		}
		return err
	}
	resp, err := p.call(ctx, http.MethodDelete, gdriveAPI+"/files/"+fileID, nil, "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("Drive 删除失败 (HTTP %d)", resp.StatusCode)
	}
	return nil
}
