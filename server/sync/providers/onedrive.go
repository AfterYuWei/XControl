package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/sync/provider"
)

const (
	graphAPI         = "https://graph.microsoft.com/v1.0"
	onedriveFolder   = "xcontrol-backups"
	simpleUploadMax  = 4 << 20 // Graph simple-upload limit: 4 MiB
)

// onedriveProvider implements Provider over the Microsoft Graph API.
type onedriveProvider struct {
	id          string
	name        string
	accessToken string
	folder      string
	refresh     TokenRefresher
	persistCfg  func(mutate func(cfg *model.SyncProviderConfig)) error
	client      *http.Client
}

// NewOneDrive builds a OneDrive provider.
func NewOneDrive(
	id string,
	cfg *model.SyncProviderConfig,
	refresh TokenRefresher,
	persist func(mutate func(cfg *model.SyncProviderConfig)) error,
) provider.Provider {
	folder := cfg.OneDriveFolder
	if folder == "" {
		folder = onedriveFolder
	}
	return &onedriveProvider{
		id:          id,
		name:        cfg.Name,
		accessToken: cfg.OAuthAccessToken,
		folder:      folder,
		refresh:     refresh,
		persistCfg:  persist,
		client:      &http.Client{Timeout: 60 * time.Second},
	}
}

func (p *onedriveProvider) ID() string   { return p.id }
func (p *onedriveProvider) Type() string { return "onedrive" }
func (p *onedriveProvider) Name() string { return p.name }

func (p *onedriveProvider) call(ctx context.Context, method, rawURL string, body io.Reader, contentType string) (*http.Response, error) {
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

// itemURL builds the drive-item URL for a name inside the backup folder.
func (p *onedriveProvider) itemURL(name string) string {
	return fmt.Sprintf("%s/me/drive/root:/%s/%s", graphAPI, url.PathEscape(p.folder), url.PathEscape(name))
}

// ensureFolder creates the backup folder when missing (409 = exists).
func (p *onedriveProvider) ensureFolder(ctx context.Context) error {
	body, _ := json.Marshal(map[string]any{
		"name":   p.folder,
		"folder": map[string]any{},
		"@microsoft.graph.conflictBehavior": "fail",
	})
	resp, err := p.call(ctx, http.MethodPost, graphAPI+"/me/drive/root/children", bytes.NewReader(body), "application/json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict || resp.StatusCode < 400 {
		return nil
	}
	return fmt.Errorf("创建 OneDrive 文件夹失败 (HTTP %d)", resp.StatusCode)
}

func (p *onedriveProvider) Ping(ctx context.Context) error {
	return p.ensureFolder(ctx)
}

func (p *onedriveProvider) ReadIndex(ctx context.Context) (*provider.CloudIndex, error) {
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

func (p *onedriveProvider) WriteIndex(ctx context.Context, idx *provider.CloudIndex) error {
	raw, err := json.Marshal(idx)
	if err != nil {
		return err
	}
	return p.putBytes(ctx, "index.json", raw)
}

// putBytes uploads content via simple upload (files < 4 MiB, which covers
// all realistic encrypted backups).
func (p *onedriveProvider) putBytes(ctx context.Context, name string, data []byte) error {
	if len(data) > simpleUploadMax {
		return fmt.Errorf("文件超过 OneDrive 简单上传限制（4MB），版本过大")
	}
	if err := p.ensureFolder(ctx); err != nil {
		return err
	}
	resp, err := p.call(ctx, http.MethodPut, p.itemURL(name)+":/content", bytes.NewReader(data), "application/octet-stream")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("OneDrive 上传失败 (HTTP %d): %s", resp.StatusCode, string(body))
	}
	return nil
}

func (p *onedriveProvider) PutObject(ctx context.Context, name string, r io.Reader, size int64) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	return p.putBytes(ctx, name, data)
}

func (p *onedriveProvider) GetObject(ctx context.Context, name string) (io.ReadCloser, error) {
	// /content returns a 302 to a pre-authenticated download URL.
	resp, err := p.call(ctx, http.MethodGet, p.itemURL(name)+":/content", nil, "")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, provider.ErrObjectNotFound
	}
	if resp.StatusCode >= 400 {
		resp.Body.Close()
		return nil, fmt.Errorf("OneDrive 下载失败 (HTTP %d)", resp.StatusCode)
	}
	return resp.Body, nil
}

func (p *onedriveProvider) DeleteObject(ctx context.Context, name string) error {
	resp, err := p.call(ctx, http.MethodDelete, p.itemURL(name), nil, "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("OneDrive 删除失败 (HTTP %d)", resp.StatusCode)
	}
	return nil
}
