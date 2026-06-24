# SSHX SFTP 模块接口文档

> 面向后端开发人员的系统设计与对接文档。本文档基于前端已实现的 SFTP 文件管理器数据结构与交互，定义后端需要提供的 REST + WebSocket 接口。

## 1. 概述

### 1.1 设计目标

SSHX 的 SFTP 模块提供浏览器端的可视化文件管理能力，支持：

- **双栏对称文件浏览**：左右两个 pane 均可连接任意服务器（含本机），每个 pane 支持多服务器标签页。
- **目录浏览**：列表视图（单目录）与树形视图（递归展开）两种模式。
- **文件传输**：跨 pane 拖拽上传/下载，传输进度队列，支持取消。
- **文件操作**：新建文件夹、重命名、删除、复制路径。
- **路径导航**：面包屑导航、`..` 返回上级、手动输入路径。

### 1.2 架构定位

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React)                                        │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ FilePane L  │  │ FilePane R  │  │ TransferQueue  │  │
│  └──────┬──────┘  └──────┬──────┘  └───────┬────────┘  │
│         │  REST (list/stat/mkdir/...)        │  WS (progress)│
└─────────┼───────────────────────────────────┼─────────────┘
          │                                   │
┌─────────▼───────────────────────────────────▼─────────────┐
│  Backend (Go)                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ SftpHandler  │  │ SftpSession  │  │ TransferManager │  │
│  │ (REST)       │  │ (SFTP 连接)  │  │ (传输任务)      │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                 │                   │           │
│  ┌──────▼─────────────────▼───────────────────▼────────┐  │
│  │  protocol/sftp (Driver)                              │  │
│  │  基于 golang.org/x/crypto/ssh 的 SFTP subsystem      │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 1.3 现有代码复用

SFTP 模块**复用现有基础设施**，不重复造轮子：

| 复用项 | 位置 | 说明 |
|--------|------|------|
| Profile + Vault 凭据 | `model/profile.go`、`store/vault` | SFTP 连接复用 Profile 的 host/port/username，凭据从 vault 解密 |
| 协议管理器 | `protocol/manager.go` | 注册 `"sftp"` 协议，与 `"ssh"` 并列 |
| 路由风格 | `gateway/router.go` | Go 1.22+ 增强路由模式 `METHOD /api/sftp/...` |
| JSON 辅助 | `gateway/handler/common.go` | `writeJSON`/`writeError`/`decodeJSON` |
| 中间件 | `gateway/middleware` | 复用 `Recovery → Logger → CORS` |
| WebSocket Hub | `ws/hub.go` | 传输进度推送复用 hub 机制 |

---

## 2. 数据模型

### 2.1 核心数据结构（前后端共享）

以下结构必须与前端 `web/src/types/sftp.ts` **保持一致**，字段名采用 `snake_case`。

#### 2.1.1 SftpEntry（文件/目录条目）

```go
// model/sftp.go
type SftpEntry struct {
    Name    string `json:"name"`     // 文件名（不含路径），如 "App.tsx"
    Path    string `json:"path"`     // 绝对路径（无尾斜杠），如 "/web/src/App.tsx"
    IsDir   bool   `json:"is_dir"`   // 是否为目录
    Size    int64  `json:"size"`     // 字节数；目录固定为 0
    ModTime string `json:"mod_time"` // ISO 8601 时间戳
    Mode    string `json:"mode,omitempty"` // Unix 权限串，如 "rwxr-xr-x"（可选）
}
```

**JSON 示例**：
```json
{
  "name": "App.tsx",
  "path": "/web/src/App.tsx",
  "is_dir": false,
  "size": 1240,
  "mod_time": "2026-06-23T10:00:00Z",
  "mode": "rw-r--r--"
}
```

> ⚠️ 前端当前 `SftpEntry` 字段为 `isDir`（驼峰）。后端建议统一为 `is_dir`（snake_case），前端需同步调整类型定义。详见第 7 节「前端适配清单」。

#### 2.1.2 SftpServer（连接目标）

```go
type SftpServer struct {
    ID       string `json:"id"`       // 服务器标识；本机固定为 "local"，远程用 profile.id
    Name     string `json:"name"`     // 显示名，如 "生产网关"
    Host     string `json:"host"`     // 主机地址
    Port     int    `json:"port"`     // 端口；本机为 0
    Username string `json:"username"` // 登录用户名
}
```

#### 2.1.3 TransferTask（传输任务）

```go
type TransferTask struct {
    ID          string `json:"id"`            // 任务 ID
    FileName    string `json:"file_name"`     // 文件名
    Direction   string `json:"direction"`     // "upload" | "download"
    Size        int64  `json:"size"`          // 总字节数
    Transferred int64  `json:"transferred"`   // 已传输字节数
    Status      string `json:"status"`        // "queued" | "transferring" | "completed" | "failed" | "cancelled"
    Speed       int64  `json:"speed"`         // 字节/秒
    StartedAt   int64  `json:"started_at"`    // Unix 毫秒时间戳
    FinishedAt  *int64 `json:"finished_at,omitempty"` // 完成时间戳
    ErrorMessage string `json:"error_message,omitempty"` // 失败原因
}
```

### 2.2 SFTP 会话（后端内部）

后端维护 SFTP 会话，与终端会话（`SessionHandler`）平行但独立：

```go
// gateway/handler/sftp.go
type SftpSession struct {
    ID        string            // 会话 ID（UUID）
    ProfileID string            // 关联的 Profile ID；本机为 "local"
    Client    *sftp.Client      // SFTP 客户端
    Status    string            // "connecting" | "connected" | "disconnected"
    Error     string
    CreatedAt time.Time
}

type SftpHandler struct {
    sessions map[string]*SftpSession
    mu       sync.RWMutex
    profiles store.ProfileStore
    vault    store.VaultStore
    pm       *protocol.Manager
    transfers *TransferManager // 传输任务管理器
}
```

---

## 3. 协议驱动扩展

### 3.1 SFTP Driver 接口

在 `protocol/` 下新增 SFTP 驱动，复用 SSH 连接的 SFTP subsystem：

```go
// protocol/sftp/driver.go
package sftp

import (
    "context"
    "fmt"

    gossh "golang.org/x/crypto/ssh"
    "github.com/pkg/sftp"
    "github.com/yuweinfo/sshx/protocol"
)

type Driver struct {
    opts   protocol.DriverOpts
    client *gossh.Client
    sftp   *sftp.Client
    info   protocol.ConnectionInfo
}

func NewDriver(opts protocol.DriverOpts) (protocol.Driver, error) {
    return &Driver{opts: opts}, nil
}
```

### 3.2 Connect 实现

`Connect` 复用 `protocol/ssh/driver.go` 的 `buildSSHConfig` 逻辑建立 SSH 连接，再在其上开启 SFTP channel：

```go
func (d *Driver) Connect(ctx context.Context) error {
    config, err := buildSSHConfig(d.opts) // 复用 ssh 包的配置构建
    if err != nil {
        return fmt.Errorf("build ssh config: %w", err)
    }

    addr := net.JoinHostPort(d.opts.Host, fmt.Sprintf("%d", d.opts.Port))
    client, err := gossh.Dial("tcp", addr, config)
    if err != nil {
        return fmt.Errorf("ssh dial: %w", err)
    }
    d.client = client

    // 开启 SFTP subsystem
    sc, err := sftp.NewClient(client)
    if err != nil {
        client.Close()
        return fmt.Errorf("new sftp client: %w", err)
    }
    d.sftp = sc

    d.info = protocol.ConnectionInfo{
        Protocol: "sftp",
        Host:     d.opts.Host,
        Port:     d.opts.Port,
        Username: d.opts.Username,
    }
    return nil
}
```

### 3.3 文件操作方法

Driver 扩展文件操作方法（不放入 `protocol.Driver` 接口，避免污染终端驱动）：

```go
func (d *Driver) SftpClient() *sftp.Client { return d.sftp }

func (d *Driver) List(path string) ([]*sftp.FileStat, error)
func (d *Driver) Stat(path string) (*sftp.FileStat, error)
func (d *Driver) Mkdir(path string) error
func (d *Driver) Remove(path string) error
func (d *Driver) Rename(oldPath, newPath string) error
func (d *Driver) ReadFile(path string) (io.ReadCloser, error)
func (d *Driver) WriteFile(path string) (io.WriteCloser, error)
```

### 3.4 注册到 Manager

```go
// gateway/router.go 中
pm.Register("sftp", func(opts protocol.DriverOpts) (protocol.Driver, error) {
    return sftpdriver.NewDriver(opts)
})
```

---

## 4. REST 接口

所有接口前缀 `/api/sftp`，遵循现有路由风格（Go 1.22+ `METHOD /api/sftp/...`）。

### 4.1 会话管理

#### 4.1.1 创建 SFTP 会话

```
POST /api/sftp/sessions
```

打开一个 SFTP 连接。本机连接传 `profile_id: "local"`，远程连接传 Profile ID。

**请求体**：
```json
{
  "profile_id": "srv-1"
}
```

**响应** `201 Created`：
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "connecting"
}
```

**错误**：

| 状态码 | code | 说明 |
|--------|------|------|
| 400 | `VALIDATION` | `profile_id` 为空 |
| 404 | `NOT_FOUND` | Profile 不存在 |
| 500 | `CONNECT_FAILED` | SFTP 连接失败 |

**实现要点**：
- 复用 `SessionHandler.Create` 的凭据解析流程：从 `profile.VaultID` 取 vault 凭据解密。
- 本机 (`profile_id == "local"`) 直接使用本地文件系统，不走 SFTP 协议。
- 连接异步进行（与终端会话一致），先返回 `connecting`，通过状态查询或 WebSocket 获取结果。

#### 4.1.2 查询会话状态

```
GET /api/sftp/sessions/{id}
```

**响应** `200 OK`：
```json
{
  "id": "550e8400-...",
  "profile_id": "srv-1",
  "status": "connected",
  "created_at": "2026-06-24T10:00:00Z"
}
```

#### 4.1.3 列出所有会话

```
GET /api/sftp/sessions
```

**响应** `200 OK`：`SftpSession[]`

#### 4.1.4 关闭会话

```
DELETE /api/sftp/sessions/{id}
```

**响应** `204 No Content`

关闭时需：取消该会话关联的所有进行中传输任务，关闭 SFTP client，关闭底层 SSH client。

---

### 4.2 文件操作

所有文件操作接口需在请求中携带 `session_id`（查询参数或请求体）。

#### 4.2.1 列出目录

```
GET /api/sftp/sessions/{id}/list?path=/web/src
```

**查询参数**：
- `path`（必填）：绝对路径

**响应** `200 OK`：
```json
{
  "path": "/web/src",
  "entries": [
    {
      "name": "components",
      "path": "/web/src/components",
      "is_dir": true,
      "size": 0,
      "mod_time": "2026-06-23T10:00:00Z"
    },
    {
      "name": "App.tsx",
      "path": "/web/src/App.tsx",
      "is_dir": false,
      "size": 1240,
      "mod_time": "2026-06-23T10:00:00Z"
    }
  ]
}
```

**错误**：

| 状态码 | code | 说明 |
|--------|------|------|
| 400 | `VALIDATION` | path 为空 |
| 403 | `PERMISSION_DENIED` | 无权限访问该路径 |
| 404 | `NOT_FOUND` | 路径不存在 |
| 409 | `SESSION_NOT_CONNECTED` | 会话未就绪 |

#### 4.2.2 获取文件信息

```
GET /api/sftp/sessions/{id}/stat?path=/web/src/App.tsx
```

**响应** `200 OK`：单个 `SftpEntry`

#### 4.2.3 递归列出（树形视图）

```
GET /api/sftp/sessions/{id}/tree?path=/&depth=3
```

**查询参数**：
- `path`（必填）：起始路径
- `depth`（可选，默认 `3`）：递归深度，防止超大目录树耗尽内存

**响应** `200 OK`：
```json
{
  "path": "/",
  "entries": [
    {
      "name": "web",
      "path": "/web",
      "is_dir": true,
      "size": 0,
      "mod_time": "...",
      "children": [
        {
          "name": "src",
          "path": "/web/src",
          "is_dir": true,
          "size": 0,
          "children": [/* depth 未到则继续递归 */]
        }
      ]
    }
  ]
}
```

> 树形结构用于前端「树形视图」。深度限制避免一次拉取过多数据。前端可按需懒加载（展开节点时再请求子目录）。

#### 4.2.4 新建文件夹

```
POST /api/sftp/sessions/{id}/mkdir
```

**请求体**：
```json
{
  "path": "/web/src/new-folder"
}
```

**响应** `201 Created`：返回新建的 `SftpEntry`

**错误**：`409 PATH_EXISTS`（路径已存在）

#### 4.2.5 重命名 / 移动

```
POST /api/sftp/sessions/{id}/rename
```

**请求体**：
```json
{
  "old_path": "/web/src/old-name.tsx",
  "new_path": "/web/src/new-name.tsx"
}
```

**响应** `200 OK`：返回重命名后的 `SftpEntry`

#### 4.2.6 删除

```
POST /api/sftp/sessions/{id}/delete
```

**请求体**：
```json
{
  "paths": ["/web/src/old.tsx", "/web/src/temp"]
}
```

支持批量删除。目录递归删除。

**响应** `200 OK`：
```json
{
  "deleted": 2,
  "failed": 0
}
```

**错误**：`403 PERMISSION_DENIED`、`404 NOT_FOUND`

#### 4.2.7 复制路径

无需后端接口，前端直接从 `SftpEntry.path` 复制到剪贴板（已实现）。

---

## 5. 文件传输接口

### 5.1 传输模型

传输是**异步任务**：前端发起后立即获得 `task_id`，通过 WebSocket 接收进度更新，或通过 REST 查询状态。

### 5.2 上传

```
POST /api/sftp/sessions/{id}/upload
Content-Type: multipart/form-data
```

**表单字段**：
- `file`：文件二进制（支持多文件，字段名重复）
- `dest_dir`：目标目录绝对路径，如 `/root/uploads`
- `overwrite`：`true`/`false`，是否覆盖同名文件

**响应** `202 Accepted`：
```json
{
  "tasks": [
    {
      "id": "tx-1719235200-a1b2-archive.zip",
      "file_name": "archive.zip",
      "direction": "upload",
      "size": 5242880,
      "status": "queued",
      "started_at": 1719235200000
    }
  ]
}
```

### 5.3 下载

```
POST /api/sftp/sessions/{id}/download
```

**请求体**（JSON）：
```json
{
  "paths": ["/root/logs/access.log", "/root/logs/error.log"]
}
```

**响应** `202 Accepted`：
```json
{
  "tasks": [
    {
      "id": "tx-1719235200-c3d4-access.log",
      "file_name": "access.log",
      "direction": "download",
      "size": 145000,
      "status": "queued",
      "started_at": 1719235200000
    }
  ],
  "download_url": "/api/sftp/transfers/{task_id}/file"
}
```

下载流程：先创建任务，任务完成后前端通过 `download_url` 拉取文件流。多文件打包为 zip。

### 5.4 查询传输任务

```
GET /api/sftp/transfers?session_id={id}
```

**查询参数**：
- `session_id`（可选）：过滤某会话的任务
- `status`（可选）：过滤状态

**响应** `200 OK`：`TransferTask[]`

### 5.5 取消传输

```
DELETE /api/sftp/transfers/{task_id}
```

**响应** `200 OK`：
```json
{
  "id": "tx-...",
  "status": "cancelled"
}
```

### 5.6 清除已完成

```
DELETE /api/sftp/transfers?status=completed
```

---

## 6. WebSocket 传输进度推送

复用现有 `/ws` Hub 机制，新增 SFTP 传输进度消息类型。

### 6.1 连接

```
GET /ws?session_id={sftp_session_id}
```

或独立路径（推荐，避免与终端 WebSocket 混淆）：

```
GET /api/sftp/ws?session_id={sftp_session_id}
```

### 6.2 消息协议

沿用现有 JSON 消息格式（`type` 字段路由）。新增以下消息类型：

#### 6.2.1 传输进度（服务器 → 客户端）

```json
{
  "type": "transfer_progress",
  "payload": {
    "task_id": "tx-1719235200-a1b2-archive.zip",
    "transferred": 2621440,
    "size": 5242880,
    "speed": 1048576,
    "status": "transferring"
  }
}
```

推送频率：每 `500ms` 一次（避免淹没前端）。最后一条为 `completed`/`failed`。

#### 6.2.2 传输完成

```json
{
  "type": "transfer_complete",
  "payload": {
    "task_id": "tx-...",
    "status": "completed",
    "finished_at": 1719235210000
  }
}
```

#### 6.2.3 传输失败

```json
{
  "type": "transfer_failed",
  "payload": {
    "task_id": "tx-...",
    "status": "failed",
    "error_message": "permission denied: /root/readonly/file"
  }
}
```

#### 6.2.4 会话状态变更

```json
{
  "type": "sftp_session_status",
  "payload": {
    "session_id": "...",
    "status": "connected"
  }
}
```

### 6.3 客户端消息（保留）

当前前端无需向服务器发送消息。保留 `ping`/`pong` 心跳（与终端 WS 一致）。

---

## 7. 前端适配清单

后端实现后，前端需做以下调整以对接真实接口（替换 mock）：

### 7.1 字段命名对齐

前端 `types/sftp.ts` 当前为驼峰，后端为 snake_case。需修改：

| 前端当前 | 后端规范 | 说明 |
|----------|----------|------|
| `isDir` | `is_dir` | 字段名 |
| `modTime` | `mod_time` | 字段名 |
| `fileName` | `file_name` | 字段名 |
| `startedAt` | `started_at` | 字段名 |
| `finishedAt` | `finished_at` | 字段名 |
| `errorMessage` | `error_message` | 字段名 |
| `transferred` | `transferred` | 已一致 |

### 7.2 API 客户端

新增 `web/src/api/sftp.ts`，与现有 `api/profile.ts`、`api/session.ts` 风格一致：

```typescript
// web/src/api/sftp.ts
import { api } from './client'
import type { SftpEntry, SftpServer, TransferTask } from '@/types/sftp'

export const sftpApi = {
  // 会话
  createSession: (profileId: string) =>
    api.post<{ session_id: string; status: string }>('/api/sftp/sessions', { profile_id: profileId }),
  closeSession: (id: string) => api.delete(`/api/sftp/sessions/${id}`),

  // 文件操作
  list: (sessionId: string, path: string) =>
    api.get<{ path: string; entries: SftpEntry[] }>(
      `/api/sftp/sessions/${sessionId}/list`, // query 拼接 path
    ),
  tree: (sessionId: string, path: string, depth = 3) =>
    api.get(`/api/sftp/sessions/${sessionId}/tree`),
  mkdir: (sessionId: string, path: string) =>
    api.post(`/api/sftp/sessions/${sessionId}/mkdir`, { path }),
  rename: (sessionId: string, oldPath: string, newPath: string) =>
    api.post(`/api/sftp/sessions/${sessionId}/rename`, { old_path: oldPath, new_path: newPath }),
  delete: (sessionId: string, paths: string[]) =>
    api.post(`/api/sftp/sessions/${sessionId}/delete`, { paths }),

  // 传输
  upload: (sessionId: string, file: File, destDir: string) => { /* FormData */ },
  download: (sessionId: string, paths: string[]) =>
    api.post(`/api/sftp/sessions/${sessionId}/download`, { paths }),
  cancelTransfer: (taskId: string) => api.delete(`/api/sftp/transfers/${taskId}`),
  listTransfers: (sessionId?: string) =>
    api.get<TransferTask[]>('/api/sftp/transfers'),
}
```

### 7.3 Store 改造

`store/sftp.ts` 当前用 mock 数据（`LOCAL_TREE`/`REMOTE_TREE`/`simulateProgress`）。对接时：

1. `connectServer(pane, server)` → 调 `sftpApi.createSession(server.id)`，拿到 `session_id` 存入 `SftpTab.sessionId`。
2. `navigate(pane, path)` → 调 `sftpApi.list(tab.sessionId, path)`，用响应填充当前 entries（替换 `listFor` mock）。
3. `startTransfer` → 调 `sftpApi.upload/download`，用 WebSocket 进度消息替换 `simulateProgress` 定时器。
4. `SftpTab` 增加 `sessionId: string` 字段。

### 7.4 WebSocket Hook

新增 `hooks/useSftpTransfer.ts`，订阅传输进度：

```typescript
function useSftpTransfer(sessionId: string, onProgress: (msg) => void) {
  // 连接 /api/sftp/ws?session_id=...
  // 监听 transfer_progress / transfer_complete / transfer_failed
}
```

---

## 8. 安全考虑

### 8.1 路径校验

- **路径穿越防护**：所有路径参数必须解析为绝对路径，拒绝 `..` 越界。服务端用 `filepath.Clean` + `filepath.Abs` 规范化后校验。
- **本机沙箱**（推荐）：本机连接 (`profile_id == "local"`) 限制在配置的根目录下（如工作区目录），避免暴露整个文件系统。配置项 `SSHX_LOCAL_ROOT`。

### 8.2 凭据安全

- 凭据从 vault 解密，仅在后端内存中短暂存在，不返回给前端。
- SFTP 会话关闭后立即清理内存中的凭据引用。

### 8.3 传输安全

- 大文件传输使用流式处理（`io.Copy`），避免一次性读入内存。
- 限制单次上传文件大小（配置项 `SSHX_MAX_UPLOAD_SIZE`，默认 500MB）。
- 限制并发传输数量（默认 5），超出排队。

### 8.4 审计日志

文件操作写入 `audit_logs` 表，复用现有 `AuditStore`：

| Action | Detail 示例 |
|--------|-------------|
| `sftp_list` | `path=/root/app` |
| `sftp_mkdir` | `path=/root/new` |
| `sftp_delete` | `paths=/root/a,/root/b` |
| `sftp_upload` | `dest=/root/uploads/archive.zip size=5242880` |
| `sftp_download` | `path=/root/logs/access.log size=145000` |

---

## 9. 路由注册汇总

在 `gateway/router.go` 的 `NewRouter` 中新增：

```go
// SFTP handler
sftpH := handler.NewSftpHandler(profileStore, vaultStore, auditStore, pm)

// SFTP session routes
mux.HandleFunc("POST /api/sftp/sessions", sftpH.CreateSession)
mux.HandleFunc("GET /api/sftp/sessions", sftpH.ListSessions)
mux.HandleFunc("GET /api/sftp/sessions/{id}", sftpH.GetSession)
mux.HandleFunc("DELETE /api/sftp/sessions/{id}", sftpH.CloseSession)

// SFTP file operations
mux.HandleFunc("GET /api/sftp/sessions/{id}/list", sftpH.List)
mux.HandleFunc("GET /api/sftp/sessions/{id}/stat", sftpH.Stat)
mux.HandleFunc("GET /api/sftp/sessions/{id}/tree", sftpH.Tree)
mux.HandleFunc("POST /api/sftp/sessions/{id}/mkdir", sftpH.Mkdir)
mux.HandleFunc("POST /api/sftp/sessions/{id}/rename", sftpH.Rename)
mux.HandleFunc("POST /api/sftp/sessions/{id}/delete", sftpH.Delete)

// SFTP transfers
mux.HandleFunc("POST /api/sftp/sessions/{id}/upload", sftpH.Upload)
mux.HandleFunc("POST /api/sftp/sessions/{id}/download", sftpH.Download)
mux.HandleFunc("GET /api/sftp/transfers", sftpH.ListTransfers)
mux.HandleFunc("DELETE /api/sftp/transfers/{task_id}", sftpH.CancelTransfer)

// SFTP WebSocket (可选独立路径)
mux.HandleFunc("GET /api/sftp/ws", sftpWsH.Handle)
```

---

## 10. 新增文件清单

### 后端

```
server/
├── model/sftp.go                  # SftpEntry, SftpServer, TransferTask, 请求/响应结构
├── protocol/sftp/
│   ├── driver.go                  # SFTP Driver（基于 ssh + sftp subsystem）
│   └── build_config.go            # 复用 ssh 包的 buildSSHConfig（可抽取共享）
├── gateway/handler/
│   ├── sftp.go                    # SftpHandler（会话 + 文件操作 REST）
│   └── sftp_transfer.go           # TransferManager（传输任务 + 进度）
└── store/                         # 如需持久化传输历史，新增 sftp_transfer_store
```

### 前端（对接阶段）

```
web/src/
├── api/sftp.ts                    # SFTP API 客户端
├── hooks/useSftpTransfer.ts       # 传输进度 WebSocket
└── types/sftp.ts                  # 字段名改为 snake_case
```

---

## 11. 实施建议（分阶段）

### Phase 1：只读浏览（最小可用）

1. `protocol/sftp/driver.go` — Connect + List + Stat
2. `handler/sftp.go` — `POST /sessions` + `GET /sessions/{id}/list`
3. 前端 `api/sftp.ts` — 替换 `listFor` mock

**验收**：能连接服务器并浏览目录。

### Phase 2：文件操作

1. Mkdir / Rename / Delete 接口
2. 前端右键菜单接通真实操作

**验收**：能新建文件夹、重命名、删除。

### Phase 3：文件传输

1. Upload（multipart）+ Download（流式 + zip 打包）
2. TransferManager + WebSocket 进度推送
3. 前端替换 `simulateProgress`

**验收**：能跨 pane 拖拽上传/下载，进度条实时更新，可取消。

### Phase 4：增强

1. 树形视图懒加载（`GET /tree?depth=1` 按需展开）
2. 本机沙箱配置 `SSHX_LOCAL_ROOT`
3. 传输大小/并发限制
4. 审计日志接入

---

## 12. 开放问题

以下需前后端协商确认：

1. **本机文件访问范围**：本机连接是否限制在工作区目录？还是允许访问整个文件系统？（建议沙箱，配置 `SSHX_LOCAL_ROOT`）
答: 允许访问整个文件系统
2. **传输历史持久化**：传输任务是否需要持久化到 SQLite，还是仅内存？（建议内存即可，刷新页面后历史不保留）
答: 仅内存
3. **大文件分片上传**：是否需要支持断点续传/分片上传？（Phase 3 可暂不支持，后续按需）
答：暂不支持
4. **多文件下载打包**：多文件下载是否打包为 zip？还是逐个下载？（建议 zip）
答: 打包为 zip
5. **权限校验**：是否需要按用户隔离文件访问权限？（当前无用户体系，暂不需要）
答: 不需要
