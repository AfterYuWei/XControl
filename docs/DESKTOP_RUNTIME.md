# Desktop Runtime

eizhu 桌面版是单进程 Tauri 2 应用。React 静态资源由 Tauri 打包，SQLite、加密、
SSH、SFTP、备份和同步均在 Rust 主进程内执行。

## 启动

1. Tauri 初始化单实例、深链、外链、对话框、拖拽和更新插件。
2. 从历史兼容的 `eizhu` 用户目录打开数据库与密钥。
3. 初始化各领域 state，启动同步调度器并注册 OAuth 深链。
4. React 完成 Electron 设置迁移后渲染首帧，调用 `frontend_ready` 显示窗口。

## 通信边界

- 查询和变更：细粒度 Tauri command。
- 终端和 SFTP 进度：Tauri event。
- 上传和下载：Tauri 原生二进制 IPC body/response。
- OAuth provider：Rust `reqwest` 直接访问远端服务。
- SSH/SFTP：Rust `russh` 与 `russh-sftp` 直接连接目标服务器。

不存在 loopback HTTP、运行时端口、访问令牌或 WebSocket 网关。

## 退出

`RunEvent::ExitRequested` 依次关闭 SSH/SFTP 会话、同步调度器与退出备份任务。
任务通过 cancellation token 取消，远端句柄随 state 释放。

## 构建与烟测

```bash
npm run desktop:dev
npm run desktop:build
npm run desktop:smoke
```

`--smoke-test` 会完成数据库、加密器及全部领域 state 初始化，输出
`EIZHU_TAURI_SMOKE_OK` 后退出。CI 另执行 Rust clippy/test 和前端 lint/test/build。
