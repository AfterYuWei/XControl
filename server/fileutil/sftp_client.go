package fileutil

import (
	gossh "golang.org/x/crypto/ssh"
	"github.com/pkg/sftp"
)

// SFTP 吞吐调优参数。pkg/sftp 默认 32KB 包 + 顺序写，在高延迟链路上
// 吞吐被限制在约 32KB/RTT。以下参数启用流水线传输。
const (
	// sftpMaxPacket 是 OpenSSH 接受的最大单请求读写大小。
	sftpMaxPacket = 256 * 1024

	// SftpConcurrentRequests 是单个文件同时在途的请求数。
	SftpConcurrentRequests = 64
)

// NewSftpClient 在已有 SSH 连接上打开 SFTP 子系统通道，并针对吞吐调优：
//   - 256KB 请求包（OpenSSH 上限；默认 32KB 是高延迟链路的主要瓶颈）
//   - 并发读（pkg/sftp 默认开启）与并发写，使每个往返有多个请求在途
//
// 调用方在整文件传输时应使用 File.WriteTo / ReadFromWithConcurrency
// 才能真正利用流水线。
func NewSftpClient(conn *gossh.Client) (*sftp.Client, error) {
	return sftp.NewClient(conn,
		sftp.MaxPacketUnchecked(sftpMaxPacket),
		sftp.MaxConcurrentRequestsPerFile(SftpConcurrentRequests),
		sftp.UseConcurrentWrites(true),
	)
}
