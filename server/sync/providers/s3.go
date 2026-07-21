package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/sync/provider"
)

// s3Provider implements Provider over S3-compatible storage
// (AWS S3, MinIO, Cloudflare R2, etc.).
type s3Provider struct {
	id     string
	name   string
	client *s3.Client
	bucket string
	prefix string // normalized, ends with "/" when non-empty
}

// NewS3 builds an S3 provider from decrypted config.
func NewS3(id string, cfg *model.SyncProviderConfig) (provider.Provider, error) {
	awsCfg := aws.Config{
		Region:      cfg.S3Region,
		Credentials: credentials.NewStaticCredentialsProvider(cfg.S3AccessKey, cfg.S3SecretKey, ""),
	}
	if awsCfg.Region == "" {
		awsCfg.Region = "us-east-1"
	}
	opts := func(o *s3.Options) {
		if cfg.S3Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.S3Endpoint)
		}
		o.UsePathStyle = cfg.S3PathStyle
	}
	prefix := cfg.S3Prefix
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return &s3Provider{
		id:     id,
		name:   cfg.Name,
		client: s3.NewFromConfig(awsCfg, opts),
		bucket: cfg.S3Bucket,
		prefix: prefix,
	}, nil
}

func (p *s3Provider) ID() string   { return p.id }
func (p *s3Provider) Type() string { return "s3" }
func (p *s3Provider) Name() string { return p.name }

func (p *s3Provider) key(name string) string { return p.prefix + name }

func isNotFound(err error) bool {
	var nsk *types.NoSuchKey
	var nf *types.NotFound
	return errors.As(err, &nsk) || errors.As(err, &nf)
}

func (p *s3Provider) Ping(ctx context.Context) error {
	probe := p.key(".xcontrol-probe")
	if _, err := p.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(probe),
		Body:   strings.NewReader("ok"),
	}); err != nil {
		return fmt.Errorf("s3 连接或写入失败: %w", err)
	}
	_, _ = p.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(probe),
	})
	return nil
}

func (p *s3Provider) ReadIndex(ctx context.Context) (*provider.CloudIndex, error) {
	out, err := p.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(p.key("index.json")),
	})
	if err != nil {
		if isNotFound(err) {
			return provider.NewCloudIndex(), nil
		}
		return nil, fmt.Errorf("读取云端索引失败: %w", err)
	}
	defer out.Body.Close()
	var idx provider.CloudIndex
	if err := json.NewDecoder(out.Body).Decode(&idx); err != nil {
		return nil, fmt.Errorf("云端索引损坏: %w", err)
	}
	if idx.Versions == nil {
		idx.Versions = []provider.CloudVersionInfo{}
	}
	return &idx, nil
}

func (p *s3Provider) WriteIndex(ctx context.Context, idx *provider.CloudIndex) error {
	raw, err := json.Marshal(idx)
	if err != nil {
		return err
	}
	_, err = p.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(p.key("index.json")),
		Body:   bytes.NewReader(raw),
	})
	if err != nil {
		return fmt.Errorf("写入云端索引失败: %w", err)
	}
	return nil
}

func (p *s3Provider) PutObject(ctx context.Context, name string, r io.Reader, size int64) error {
	_ = size
	_, err := p.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(p.key(name)),
		Body:   r,
	})
	if err != nil {
		return fmt.Errorf("上传失败: %w", err)
	}
	return nil
}

func (p *s3Provider) GetObject(ctx context.Context, name string) (io.ReadCloser, error) {
	out, err := p.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(p.key(name)),
	})
	if err != nil {
		if isNotFound(err) {
			return nil, provider.ErrObjectNotFound
		}
		return nil, fmt.Errorf("下载失败: %w", err)
	}
	return out.Body, nil
}

func (p *s3Provider) DeleteObject(ctx context.Context, name string) error {
	_, err := p.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(p.key(name)),
	})
	if err != nil && !isNotFound(err) {
		return fmt.Errorf("删除失败: %w", err)
	}
	return nil
}
