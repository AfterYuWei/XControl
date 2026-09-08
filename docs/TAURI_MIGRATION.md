# Tauri / Rust 迁移状态

迁移已经完成。当前发布物只包含 Tauri 主程序与 React 静态资产，所有本地业务、SSH、
SFTP、同步与备份代码均为 Rust。

## 最终结构

```text
React WebView
  ├─ invoke → Rust domain commands
  ├─ event  ← terminal / transfer progress
  └─ binary IPC ↔ uploads / downloads

Tauri Rust process
  ├─ SQLite + AES-GCM credential storage
  ├─ SSH transport + PTY + host-key policy
  ├─ SFTP + editor + transfers + drag-out
  ├─ backup + sync providers + OAuth scheduler
  └─ native window/dialog/updater/deep-link plugins
```

数据目录和数据库 schema 保持兼容，因此旧版本升级不需要导入导出。React 的 UI 偏好仍
使用 localStorage，并在首次运行时从 Electron `settings.json` 一次性迁移。

## 已移除边界

- 本地 HTTP 路由、CORS 与 bearer token。
- WebSocket 终端/进度/指标通道。
- 外部业务进程、健康轮询与进程清理。
- 跨语言 RPC/IPC 适配层。

详细领域映射和兼容性验证见 `GO_TO_RUST_MIGRATION.md`。
