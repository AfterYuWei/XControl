//go:build !prod

package config

// 开发环境：数据存储到项目根目录的 data/ 文件夹
// 从 server/ 目录运行时，../data/ 指向项目根目录
const (
	defaultDBPath  = "../data/xcontrol.db"
	defaultKeyPath = "../data/key"
)
