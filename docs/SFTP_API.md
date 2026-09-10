# SFTP 领域接口

SFTP 由 `src-tauri/src/sftp/` 实现，React 封装位于 `web/src/api/sftp.ts`。

## 会话与文件

- `sftp_create_session`、`sftp_get_session`、`sftp_list_sessions`、`sftp_close_session`
- `sftp_list`、`sftp_stat`、`sftp_tree`
- `sftp_mkdir`、`sftp_rename`、`sftp_delete`、`sftp_move`
- `sftp_read_file`、`sftp_write_file`

路径使用 POSIX 表示；本机会话在 Windows 上把 `/C:/...` 转回原生路径。目录列表默认
隐藏点文件。编辑器限制 10 MiB，拒绝二进制和非 UTF-8 内容，并用 `mod_time` 乐观锁避免覆盖。

## 传输

- `sftp_upload_begin` / `sftp_upload_chunk` / `sftp_upload_finish` / `sftp_upload_abort`：
  浏览器通过 `File.stream()` 顺序推送原生二进制块，Rust 直接写入目标文件；单块 512 KiB，
  后端硬限制 1 MiB。每次 invoke 仅在目标 writer 写入完成后返回，形成端到端背压；异常或取消
  会关闭 writer 并删除未完成的目标文件。Android/iOS 使用同尺寸的 Base64 分块 command，
  避开移动端 WebView 对 raw invoke body/response 的限制，仍不会聚合完整文件。
- `sftp_download`：Rust 以 128 KiB 缓冲从 SFTP 流式落盘；多文件/目录先流式复制到临时目录，
  再直接写入 ZIP 文件，全程不聚合文件内容到内存。
- `sftp_download_chunk` / `sftp_download_close`：前端以 `ReadableStream` 按 offset 拉取 512 KiB
  二进制块；EOF、取消或读取异常都会调用 close 删除落盘文件和任务。
- `sftp_transfer`：不同会话间流式 relay；目录可保留结构或生成 `tar.gz`。
- `sftp_list_transfers`、`sftp_cancel_transfer`、`sftp_clear_completed_transfers`。

冲突策略为 `ask`、`overwrite`、`rename`、`skip`。进度通过
`eizhu-sftp-message` event 推送，任务状态仍可轮询，最多同时执行五个传输。

## 连接能力

远端会话复用 `ssh/transport.rs`，支持密码、私钥、SSH agent、SOCKS5、HTTP CONNECT
和多级 SSH jump。主机指纹变化会拒绝 SFTP 建连；用户需先在 Profile 测试中确认新指纹。
