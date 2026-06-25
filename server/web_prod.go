//go:build prod

package main

import (
	"embed"
	"io/fs"
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
