//go:build prod

package main

import (
	"embed"
	"io/fs"

	"github.com/yuweinfo/xcontrol/config"
)

// embeddedWeb 在 prod 构建时把前端构建产物（web_dist/）嵌入到二进制中。
// 构建顺序：先 `npm run build`（输出到 server/web_dist），再 `go build -tags prod`。
//
//go:embed all:web_dist
var embeddedWeb embed.FS

// WebFS 返回嵌入的前端静态文件系统（根指向 web_dist 目录）。
func WebFS() fs.FS {
	sub, err := fs.Sub(embeddedWeb, "web_dist")
	if err != nil {
		return nil
	}
	return sub
}

// SetDevDefaults 在生产模式下为空实现（不覆盖配置）。
func SetDevDefaults(cfg *config.Config) {
	// 生产模式不修改配置，保持环境变量或默认值
}
