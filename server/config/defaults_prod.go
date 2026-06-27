//go:build prod

package config

// 生产环境：数据存储到二进制文件同级的 data/ 文件夹
const (
	defaultDBPath  = "./data/xcontrol.db"
	defaultKeyPath = "./data/key"
)
