//go:build !prod

package config

// 开发环境：数据存储到项目根目录的 data/ 文件夹
// 从 server/ 目录运行时，../data/ 指向项目根目录
const (
	defaultHost           = "127.0.0.1"
	defaultDBPath         = "../data/xcontrol.db"
	defaultKeyPath        = "../data/key"
	defaultAllowedOrigins = "http://localhost:5173,http://127.0.0.1:5173"
)
