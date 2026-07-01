//go:build !prod

package main

import (
	"io/fs"

	"github.com/yuweinfo/xcontrol/config"
)

// WebFS 返回前端静态文件系统。
// 开发模式下返回 nil：前端由 Vite dev server（默认 5173）提供，
// 后端只负责 /api 与 /ws。此时 NewRouter 不会注册静态文件路由。
//
// 开发运行： go run .              （默认 dev 模式）
// 打包构建： go build -tags prod . （启用 embed，见 web_prod.go）
func WebFS() fs.FS {
	return nil
}

// SetDevDefaults 覆盖开发模式的默认配置。
// 仅在开发模式下生效（prod 构建时此函数不存在，见 web_prod.go）。
func SetDevDefaults(cfg *config.Config) {
	// 开发模式强制开启 debug 日志，便于排查问题
	cfg.LogLevel = "debug"
}
