# Electron 桌面运行说明

Electron 是 XControl 的正式运行形态；Vite Web 模式仅用于开发调试。

## 启动与安全边界

1. Electron 主进程选择一个空闲回环端口。
2. 主进程生成 256 位随机访问令牌，通过 `XCONTROL_ACCESS_TOKEN` 传给 Go 子进程。
3. Go 服务只监听 `127.0.0.1`。
4. Electron 为该回环地址写入 `HttpOnly`、`SameSite=Strict` 的会话 Cookie。
5. REST 和 WebSocket 请求同时受访问令牌与 Origin 策略保护。
6. OAuth 回调不要求桌面 Cookie，但必须通过服务端生成的一次性 OAuth state 校验。

令牌只存在于 Electron 主进程、Go 子进程环境和 HttpOnly Cookie 中，不暴露给渲染层 JavaScript。

## 退出流程

关闭应用时，Electron 调用受令牌保护的 `POST /api/shutdown`。Go 服务依次：

1. 停止接收新的 HTTP 请求；
2. 完成退出备份；
3. 关闭 WebSocket、终端和 SFTP 会话；
4. 取消传输任务并停止清理调度器；
5. 释放 SSH/SFTP 连接池；
6. 关闭同步调度器和 SQLite。

Electron 最多等待 5 秒；只有优雅退出失败时才强制终止子进程。

## Web 调试

开发模式不设置 `XCONTROL_ACCESS_TOKEN`，因此仍可直接运行：

```bash
cd server
go run .

cd ../web
npm ci
npm run dev
```

后端与 Vite 默认都只监听回环地址。如需从其他设备调试，应显式设置：

```bash
XCONTROL_HOST=0.0.0.0
XCONTROL_ALLOWED_ORIGINS=http://debug-host:5173
npm run dev -- --host 0.0.0.0
```

不要在不可信网络中使用无访问令牌的调试模式。

## 验证

```bash
cd web
npm run lint
npm run test:unit
npm run build

cd ../server
go test ./...
go vet ./...

cd ../electron
npm ci
npm run smoke
```

`npm run smoke` 启动隐藏窗口，验证渲染进程能通过 HttpOnly Cookie 访问后端，且令牌不可从 `document.cookie` 读取，然后触发完整的优雅退出。
