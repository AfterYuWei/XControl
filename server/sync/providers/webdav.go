package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/sync/provider"
)

// webdavProvider implements Provider over plain WebDAV (PROPFIND-free:
// we only need GET/PUT/DELETE on well-known paths).
type webdavProvider struct {
	id      string
	name    string
	base    string // normalized endpoint (no trailing slash)
	user    string
	pass    string
	client  *http.Client
}

// NewWebDAV builds a WebDAV provider from decrypted config.
func NewWebDAV(id string, cfg *model.SyncProviderConfig) provider.Provider {
	return &webdavProvider{
		id:   id,
		name: cfg.Name,
		base: strings.TrimRight(cfg.Endpoint, "/"),
		user: cfg.Username,
		pass: cfg.Password,
		client: &http.Client{Timeout: 60 * time.Second},
	}
}

func (p *webdavProvider) ID() string   { return p.id }
func (p *webdavProvider) Type() string { return "webdav" }
func (p *webdavProvider) Name() string { return p.name }

func (p *webdavProvider) url(path string) string {
	return p.base + "/" + strings.TrimLeft(path, "/")
}

func (p *webdavProvider) do(ctx context.Context, method, path string, body io.Reader, size int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, p.url(path), body)
	if err != nil {
		return nil, err
	}
	if p.user != "" || p.pass != "" {
		req.SetBasicAuth(p.user, p.pass)
	}
	if size >= 0 {
		req.ContentLength = size
	}
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	return p.client.Do(req)
}

func (p *webdavProvider) Ping(ctx context.Context) error {
	// PUT a tiny probe then delete it; verifies auth + write permission.
	probe := ".xcontrol-probe"
	resp, err := p.do(ctx, http.MethodPut, probe, strings.NewReader("ok"), 2)
	if err != nil {
		return fmt.Errorf("webdav 连接失败: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("webdav 鉴权或写入失败 (HTTP %d)", resp.StatusCode)
	}
	delResp, err := p.do(ctx, "DELETE", probe, nil, -1)
	if err == nil {
		delResp.Body.Close()
	}
	return nil
}

func (p *webdavProvider) ReadIndex(ctx context.Context) (*provider.CloudIndex, error) {
	resp, err := p.do(ctx, http.MethodGet, "index.json", nil, -1)
	if err != nil {
		return nil, fmt.Errorf("读取云端索引失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return provider.NewCloudIndex(), nil
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("读取云端索引失败 (HTTP %d)", resp.StatusCode)
	}
	var idx provider.CloudIndex
	if err := json.NewDecoder(resp.Body).Decode(&idx); err != nil {
		return nil, fmt.Errorf("云端索引损坏: %w", err)
	}
	if idx.Versions == nil {
		idx.Versions = []provider.CloudVersionInfo{}
	}
	return &idx, nil
}

func (p *webdavProvider) WriteIndex(ctx context.Context, idx *provider.CloudIndex) error {
	raw, err := json.Marshal(idx)
	if err != nil {
		return err
	}
	resp, err := p.do(ctx, http.MethodPut, "index.json", bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return fmt.Errorf("写入云端索引失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("写入云端索引失败 (HTTP %d)", resp.StatusCode)
	}
	return nil
}

func (p *webdavProvider) PutObject(ctx context.Context, name string, r io.Reader, size int64) error {
	resp, err := p.do(ctx, http.MethodPut, name, r, size)
	if err != nil {
		return fmt.Errorf("上传失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("上传失败 (HTTP %d)", resp.StatusCode)
	}
	return nil
}

func (p *webdavProvider) GetObject(ctx context.Context, name string) (io.ReadCloser, error) {
	resp, err := p.do(ctx, http.MethodGet, name, nil, -1)
	if err != nil {
		return nil, fmt.Errorf("下载失败: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, provider.ErrObjectNotFound
	}
	if resp.StatusCode >= 400 {
		resp.Body.Close()
		return nil, fmt.Errorf("下载失败 (HTTP %d)", resp.StatusCode)
	}
	return resp.Body, nil
}

func (p *webdavProvider) DeleteObject(ctx context.Context, name string) error {
	resp, err := p.do(ctx, "DELETE", name, nil, -1)
	if err != nil {
		return fmt.Errorf("删除失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("删除失败 (HTTP %d)", resp.StatusCode)
	}
	return nil
}
