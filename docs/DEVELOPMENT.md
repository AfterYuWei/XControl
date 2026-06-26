# XControl 开发文档

## 1. 项目概述

XControl 是一个基于浏览器的 SSH 终端工具，参考 [Tabby](https://github.com/Eugeny/tabby)（原 Terminus）和 [Termius](https://termius.com) 的设计理念，构建一个**模块化、可扩展**的终端平台。

### 1.1 设计原则

| 原则 | 说明 |
|------|------|
| **模块化** | 各功能模块通过接口解耦，可独立开发和替换 |
| **可扩展** | 预留扩展点，未来可接入插件系统、新协议 |
| **协议无关** | 终端层与传输层分离，SSH 只是第一个协议实现 |
| **安全优先** | 凭据加密存储、审计日志、最小权限 |

### 1.2 阶段规划

```
Phase 1 (当前)         Phase 2                Phase 3
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ Web SSH 终端  │      │ 桌面打包      │      │ 平台化        │
│ 连接管理      │ ──→  │ SFTP 文件管理 │ ──→  │ 插件系统      │
│ 多会话        │      │ 会话录制回放  │      │ 多协议支持    │
│ 快捷命令      │      │ 端口转发      │      │ 团队协作      │
└──────────────┘      └──────────────┘      └──────────────┘
```

### 1.3 技术栈

#### 前端

| 技术 | 版本 | 说明 |
|------|------|------|
| React | 19+ | 新增 Compiler、use() hook、ref as prop |
| TypeScript | 5.7+ | - |
| Vite | 6+ | Environment API、更快的 HMR |
| Tailwind CSS | 4+ | CSS-first 配置、Oxide 引擎、零配置启动 |
| shadcn/ui | 2+ | 基于 Radix UI + Tailwind v4，CLI 按需引入组件 |
| @xterm/xterm | 5+ | 终端模拟器（包名已从 xterm 迁移） |
| @xterm/addon-fit | - | 终端自适应大小 |
| @xterm/addon-web-links | - | 终端链接可点击 |
| @xterm/addon-search | - | 终端搜索 |
| Zustand | 5+ | 轻量状态管理，TypeScript 友好 |
| React Router | 7+ | 路由管理 |

#### 后端

| 技术 | 版本 | 说明 |
|------|------|------|
| Go | 1.24+ | range over int、泛型改进 |
| golang.org/x/crypto/ssh | latest | SSH 协议实现 |
| github.com/coder/websocket | latest | 替代已归档的 gorilla/websocket，支持 context.Context |
| modernc.org/sqlite | latest | 纯 Go SQLite，无 CGO 依赖 |
| net/http | 标准库 | Go 1.22+ 增强路由（`mux.HandleFunc("GET /path", ...)`） |
| log/slog | 标准库 | 结构化日志 |

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器 (Client)                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Shell 层 (UI)                           │  │
│  │  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │  │
│  │  │  Tabs   │  │ Terminal │  │  SFTP    │  │ Snippets │  │  │
│  │  │ Manager │  │  Panel   │  │  Panel   │  │  Panel   │  │  │
│  │  └────┬────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │  │
│  └───────┼────────────┼────────────┼────────────┼──────────┘  │
│          │            │            │            │              │
│  ┌───────┼────────────┼────────────┼────────────┼──────────┐  │
│  │       │      Transport 层       │            │          │  │
│  │       │   ┌─────────────────┐   │            │          │  │
│  │       └──→│  Session Manager │←──┘            │          │  │
│  │           │  (会话生命周期)    │←──────────────┘          │  │
│  │           └────────┬────────┘                            │  │
│  │                    │ WebSocket                            │  │
│  └────────────────────┼────────────────────────────────────┘  │
└────────────────────────┼──────────────────────────────────────┘
                         │
┌────────────────────────┼──────────────────────────────────────┐
│                   Go Server (:8080)                             │
│                        │                                       │
│  ┌─────────────────────┼─────────────────────────────────────┐ │
│  │              Gateway 层 (入口)                              │ │
│  │   ┌──────────┐  ┌───┴──────┐  ┌───────────┐              │ │
│  │   │ REST API │  │ WS Router│  │ Auth/CORS │              │ │
│  │   └────┬─────┘  └────┬─────┘  └───────────┘              │ │
│  └────────┼─────────────┼────────────────────────────────────┘ │
│           │             │                                      │
│  ┌────────┼─────────────┼────────────────────────────────────┐ │
│  │        │      Service 层 (业务逻辑)                        │ │
│  │   ┌────┴────┐  ┌─────┴─────┐  ┌───────────┐              │ │
│  │   │Connection│  │ Session   │  │  Snippet  │              │ │
│  │   │ Service │  │  Service  │  │  Service  │              │ │
│  │   └────┬────┘  └─────┬─────┘  └───────────┘              │ │
│  └────────┼─────────────┼────────────────────────────────────┘ │
│           │             │                                      │
│  ┌────────┼─────────────┼────────────────────────────────────┐ │
│  │        │      Protocol 层 (协议抽象)                       │ │
│  │   ┌────┴─────────────┴────┐  ┌───────────┐               │ │
│  │   │   ProtocolManager     │  │   Vault   │               │ │
│  │   │  ┌─────┐ ┌─────────┐ │  │ (凭据加密) │               │ │
│  │   │  │ SSH │ │ (SFTP)  │ │  └───────────┘               │ │
│  │   │  │Driver│ │ (future)│ │                               │ │
│  │   │  └──┬──┘ └─────────┘ │                               │ │
│  │   └─────┼────────────────┘                               │ │
│  └─────────┼────────────────────────────────────────────────┘ │
│            │                                                  │
│  ┌─────────┼────────────────────────────────────────────────┐ │
│  │         │         Store 层 (数据持久化)                    │ │
│  │   ┌─────┴─────┐  ┌──────────┐  ┌───────────┐           │ │
│  │   │Connection │  │  Snippet │  │  AuditLog │           │ │
│  │   │  Store   │  │  Store   │  │   Store   │           │ │
│  │   └──────────┘  └──────────┘  └───────────┘           │ │
│  │                    SQLite                                │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                         │
                         │ SSH Protocol (TCP:22)
                         ↓
                 ┌──────────────┐
                 │ Remote Server │
                 └──────────────┘
```

### 2.2 分层职责

| 层级 | 职责 | 关键设计 |
|------|------|----------|
| **Shell 层** | 用户界面，终端渲染 | xterm.js 实例与会话 1:1 绑定 |
| **Transport 层** | 客户端会话管理、WebSocket 通信 | 自动重连、心跳、背压控制 |
| **Gateway 层** | HTTP/WS 入口、认证、路由 | 中间件链、请求上下文 |
| **Service 层** | 业务逻辑编排 | 接口驱动，可 mock 测试 |
| **Protocol 层** | 协议抽象，具体协议实现 | Driver 接口，SSH 是其中一个实现 |
| **Store 层** | 数据持久化 | Repository 模式，接口隔离 |

### 2.3 参考设计对比

| 特性 | Tabby | Termius | XControl (目标) |
|------|-------|---------|-------------|
| 连接管理 | Profile + Group | Host + Tag + Group | Profile + Group + Tag |
| 凭据管理 | OS Keychain Vault | 加密 Vault | 加密 Vault |
| 协议支持 | SSH/Serial/Local | SSH/SFTP | SSH → SFTP → Serial |
| 快捷命令 | 无 | Snippets | Snippets |
| 插件系统 | npm 插件 | 无 | Phase 3 插件 |
| 会话录制 | 无 | 无 | Phase 2 |
| 端口转发 | 支持 | 支持 | Phase 2 |
| 同步 | 云同步 | 云同步 | Phase 3 |

---

## 3. 核心数据模型

### 3.1 ER 图

```
┌──────────────┐       ┌──────────────┐
│   Profile    │       │    Group     │
│──────────────│       │──────────────│
│ id (PK)      │──┐    │ id (PK)      │
│ name         │  │    │ name         │
│ host         │  │    │ parent_id FK │←── 自引用（嵌套分组）
│ port         │  │    │ sort_order   │
│ username     │  │    │ icon         │
│ auth_type    │  │    │ created_at   │
│ vault_id FK ─┼──┼─→  └──────────────┘
│ group_id FK ─┼──┘
│ tags (JSON)  │       ┌──────────────┐
│ options (JSON│       │    Vault     │
│ note         │       │──────────────│
│ last_used_at │       │ id (PK)      │
│ sort_order   │       │ type         │
│ created_at   │       │ data (加密)   │
│ updated_at   │       │ fingerprint  │
└──────────────┘       │ created_at   │
                       └──────────────┘

┌──────────────┐       ┌──────────────┐
│   Snippet    │       │  AuditLog    │
│──────────────│       │──────────────│
│ id (PK)      │       │ id (PK)      │
│ name         │       │ profile_id   │
│ content      │       │ action       │
│ description  │       │ detail       │
│ tags (JSON)  │       │ timestamp    │
│ is_global    │       └──────────────┘
│ created_at   │
│ updated_at   │
└──────────────┘
```

### 3.2 表结构定义

```sql
-- 连接配置（Profile）
CREATE TABLE profiles (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL DEFAULT 22,
    username     TEXT NOT NULL DEFAULT 'root',
    auth_type    TEXT NOT NULL DEFAULT 'password',  -- password | key | agent
    vault_id     TEXT,                              -- 关联凭据
    group_id     TEXT REFERENCES groups(id),
    tags         TEXT DEFAULT '[]',                 -- JSON 数组
    options      TEXT DEFAULT '{}',                 -- JSON: 跳板机、代理等扩展配置
    note         TEXT DEFAULT '',
    sort_order   INTEGER DEFAULT 0,
    last_used_at DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 分组（支持嵌套）
CREATE TABLE groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT REFERENCES groups(id),  -- NULL 表示顶级分组
    icon       TEXT DEFAULT '📁',
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 凭据保险库（密码/密钥加密存储）
CREATE TABLE vault (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,             -- password | private_key
    data        TEXT NOT NULL,             -- AES-256-GCM 加密后的数据
    fingerprint TEXT,                      -- 密钥指纹（用于去重/识别）
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 快捷命令（Snippet）
CREATE TABLE snippets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    content     TEXT NOT NULL,             -- 支持 {{变量}} 占位符
    description TEXT DEFAULT '',
    tags        TEXT DEFAULT '[]',
    is_global   INTEGER DEFAULT 1,        -- 1=全局可用, 0=仅关联 profile
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 审计日志
CREATE TABLE audit_logs (
    id         TEXT PRIMARY KEY,
    profile_id TEXT,
    action     TEXT NOT NULL,              -- connect | disconnect | command
    detail     TEXT DEFAULT '',
    timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_profiles_group ON profiles(group_id);
CREATE INDEX idx_profiles_tags ON profiles(tags);
CREATE INDEX idx_audit_profile ON audit_logs(profile_id);
CREATE INDEX idx_audit_time ON audit_logs(timestamp);
```

### 3.3 Profile options 字段设计

`options` 是 JSON 字段，用于存储不常用的高级配置，避免主表字段膨胀：

```jsonc
{
  // 跳板机（Jump Host）
  "jump_host": {
    "host": "bastion.example.com",
    "port": 22,
    "username": "admin",
    "vault_id": "vault-uuid"
  },

  // 代理设置
  "proxy": {
    "type": "socks5",        // socks5 | http
    "host": "proxy.example.com",
    "port": 1080
  },

  // SSH 选项
  "ssh_options": {
    "keep_alive_interval": 30,
    "compress": true,
    "strict_host_key": false
  },

  // 终端覆盖（per-connection 终端设置）
  "terminal": {
    "theme": "dark",
    "font_size": 14
  },

  // 环境变量
  "env": {
    "LANG": "en_US.UTF-8"
  }
}
```

---

## 4. 协议抽象层设计

### 4.1 Driver 接口

这是整个架构最关键的扩展点——所有协议实现此接口，上层完全不感知具体协议：

```go
// protocol/driver.go

// Driver 是所有远程连接协议的统一接口
type Driver interface {
    // Connect 建立连接
    Connect(ctx context.Context) error

    // RequestShell 请求一个交互式 Shell
    RequestShell(opts ShellOptions) (Shell, error)

    // Close 关闭连接
    Close() error

    // Info 返回连接信息
    Info() ConnectionInfo
}

// Shell 是一个交互式终端会话
type Shell interface {
    // Write 写入数据（用户输入）
    Write(data []byte) (int, error)

    // Read 读取数据（终端输出）
    Read(buf []byte) (int, error)

    // Resize 调整终端大小
    Resize(cols, rows int) error

    // Close 关闭 Shell
    Close() error

    // Done 返回一个 channel，在 Shell 结束时关闭
    Done() <-chan struct{}

    // ExitCode 返回退出码（Shell 结束后可用）
    ExitCode() int
}

type ShellOptions struct {
    Cols int
    Rows int
    Term string // $TERM, 默认 "xterm-256color"
}

type ConnectionInfo struct {
    Protocol   string // "ssh" | "sftp" | "serial"
    Host       string
    Port       int
    Username   string
    RemoteAddr string
}
```

### 4.2 SSH Driver 实现

```go
// protocol/ssh/driver.go

type SSHDriver struct {
    profile  *model.Profile
    vault    *store.VaultStore
    client   *ssh.Client
}

func NewSSHDriver(profile *model.Profile, vault *store.VaultStore) *SSHDriver {
    return &SSHDriver{profile: profile, vault: vault}
}

func (d *SSHDriver) Connect(ctx context.Context) error {
    // 1. 从 Vault 解密凭据
    // 2. 构建 ssh.ClientConfig
    // 3. 支持跳板机（递归连接）
    // 4. ssh.Dial
}

func (d *SSHDriver) RequestShell(opts protocol.ShellOptions) (protocol.Shell, error) {
    // 1. NewSession
    // 2. RequestPty
    // 3. Shell()
    // 4. 返回 SSHShell 包装
}
```

### 4.3 未来扩展路径

```
protocol/
├── driver.go          # Driver + Shell 接口定义
├── ssh/
│   ├── driver.go      # SSH Driver 实现
│   └── shell.go       # SSH Shell 实现
├── serial/            # Phase 2: 串口连接
│   ├── driver.go
│   └── shell.go
└── local/             # Phase 2: 本地 Shell
    ├── driver.go
    └── shell.go
```

---

## 5. WebSocket 消息协议

### 5.1 协议设计

采用 JSON 文本帧 + Binary 数据帧混合方案：

```
┌─────────────────────────────────────────────────┐
│               WebSocket 帧                       │
│                                                  │
│  Text Frame (JSON):                              │
│  ┌────────────────────────────────────────────┐  │
│  │ { "type": "...", "payload": {...} }        │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Binary Frame:                                   │
│  ┌────────────────────────────────────────────┐  │
│  │ [header byte] [raw terminal data]          │  │
│  │  0x01 = terminal output                    │  │
│  │  0x02 = sftp data                          │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 5.2 消息类型

```jsonc
// ============ 客户端 → 服务端 ============

// 终端输入
{ "type": "input", "data": "ls -la\n" }

// 终端大小调整
{ "type": "resize", "payload": { "cols": 120, "rows": 40 } }

// 执行快捷命令
{ "type": "snippet", "payload": { "snippet_id": "uuid" } }

// 心跳
{ "type": "ping" }

// 请求认证（首次连接时）
{ "type": "auth", "payload": { "token": "jwt-token" } }


// ============ 服务端 → 客户端 ============

// 终端输出（也可以用 Binary 帧）
{ "type": "output", "data": "total 48\ndrwxr-xr-x ..." }

// 会话退出
{ "type": "exit", "payload": { "code": 0 } }

// 错误
{ "type": "error", "payload": { "code": "AUTH_FAILED", "message": "认证失败" } }

// 心跳响应
{ "type": "pong" }

// 会话元数据（连接成功后发送）
{ "type": "metadata", "payload": {
    "session_id": "uuid",
    "host": "192.168.1.100",
    "username": "root",
    "protocol": "ssh"
}}
```

### 5.3 错误码定义

| 错误码 | 含义 |
|--------|------|
| `AUTH_FAILED` | SSH 认证失败 |
| `CONNECTION_REFUSED` | 连接被拒绝 |
| `HOST_UNREACHABLE` | 主机不可达 |
| `TIMEOUT` | 连接超时 |
| `SESSION_NOT_FOUND` | 会话不存在 |
| `SESSION_LIMIT` | 超出会话数限制 |
| `INVALID_MESSAGE` | 消息格式错误 |

---

## 6. API 设计

### 6.1 REST API 总览

```
# 连接配置 (Profiles)
GET    /api/profiles                 # 列表（支持 ?group_id=&tag=&search= 筛选）
GET    /api/profiles/:id             # 详情
POST   /api/profiles                 # 创建
PUT    /api/profiles/:id             # 更新
DELETE /api/profiles/:id             # 删除
POST   /api/profiles/:id/test       # 测试连接
POST   /api/profiles/:id/duplicate  # 复制连接
PUT    /api/profiles/:id/move       # 移动分组 / 排序

# 分组 (Groups)
GET    /api/groups                   # 树形列表
POST   /api/groups                   # 创建
PUT    /api/groups/:id               # 更新
DELETE /api/groups/:id               # 删除（子分组上移）
PUT    /api/groups/:id/move          # 移动分组

# 快捷命令 (Snippets)
GET    /api/snippets                 # 列表
POST   /api/snippets                 # 创建
PUT    /api/snippets/:id             # 更新
DELETE /api/snippets/:id             # 删除

# 会话 (Sessions)
POST   /api/sessions                 # 创建会话
GET    /api/sessions                 # 活跃会话列表
DELETE /api/sessions/:id             # 关闭会话

# WebSocket
GET    /ws?session_id={id}           # 终端 WebSocket 连接
```

### 6.2 关键接口详细定义

#### POST /api/profiles

请求：
```json
{
  "name": "生产数据库",
  "host": "192.168.1.100",
  "port": 22,
  "username": "root",
  "auth_type": "password",
  "password": "******",
  "group_id": "group-uuid",
  "tags": ["生产", "数据库"],
  "options": {
    "jump_host": {
      "host": "bastion.example.com",
      "port": 22,
      "username": "admin",
      "password": "******"
    }
  },
  "note": "主数据库服务器"
}
```

> 注意：密码/密钥在服务端加密后存入 Vault，响应中不返回凭据字段。

#### POST /api/profiles/:id/test

响应：
```json
{
  "success": true,
  "message": "连接成功",
  "latency_ms": 23,
  "server_info": "Ubuntu 22.04, OpenSSH_8.9"
}
```

#### POST /api/sessions

请求：
```json
{
  "profile_id": "uuid",
  "cols": 80,
  "rows": 24
}
```

响应：
```json
{
  "session_id": "uuid",
  "status": "connected"
}
```

---

## 7. 项目结构

```
xcontrol/
├── server/                              # Go 后端
│   ├── main.go                          # 入口
│   ├── go.mod
│   │
│   ├── config/
│   │   └── config.go                    # 配置结构体 + 加载
│   │
│   ├── gateway/                         # Gateway 层
│   │   ├── router.go                    # 路由注册
│   │   ├── middleware/
│   │   │   ├── cors.go                  # CORS
│   │   │   ├── auth.go                  # 认证（预留）
│   │   │   ├── logger.go               # 请求日志
│   │   │   └── recovery.go             # panic 恢复
│   │   └── handler/
│   │       ├── profile.go              # Profile CRUD
│   │       ├── group.go                # Group CRUD
│   │       ├── snippet.go              # Snippet CRUD
│   │       ├── session.go              # Session 管理
│   │       └── ws.go                   # WebSocket
│   │
│   ├── service/                         # Service 层
│   │   ├── profile_service.go
│   │   ├── group_service.go
│   │   ├── snippet_service.go
│   │   ├── session_service.go
│   │   └── audit_service.go
│   │
│   ├── protocol/                        # Protocol 层
│   │   ├── driver.go                   # Driver + Shell 接口
│   │   ├── manager.go                  # ProtocolManager
│   │   └── ssh/
│   │       ├── driver.go               # SSH Driver
│   │       ├── shell.go                # SSH Shell
│   │       └── auth.go                 # 认证方式处理
│   │
│   ├── store/                           # Store 层
│   │   ├── store.go                    # Store 接口汇总
│   │   ├── profile_store.go
│   │   ├── group_store.go
│   │   ├── vault_store.go
│   │   ├── snippet_store.go
│   │   ├── audit_store.go
│   │   └── sqlite.go                   # SQLite 初始化 + 迁移
│   │
│   ├── model/                           # 数据模型
│   │   ├── profile.go
│   │   ├── group.go
│   │   ├── vault.go
│   │   ├── snippet.go
│   │   └── audit.go
│   │
│   ├── crypto/
│   │   └── aes.go                      # AES-256-GCM 加密
│   │
│   └── ws/                             # WebSocket 基础设施
│       ├── hub.go                      # 连接管理中心
│       ├── conn.go                     # WebSocket 连接封装
│       └── message.go                  # 消息类型定义
│
├── web/                                 # React 前端
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── components.json                  # shadcn/ui 配置文件
│   │
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── config.ts
│       ├── app.css                      # Tailwind v4 CSS-first 配置（@theme）
│       │
│       ├── types/                       # 类型定义
│       │   ├── profile.ts
│       │   ├── group.ts
│       │   ├── session.ts
│       │   ├── snippet.ts
│       │   └── ws.ts
│       │
│       ├── api/                         # API 封装
│       │   ├── client.ts               # fetch 基础封装
│       │   ├── profile.ts
│       │   ├── group.ts
│       │   ├── snippet.ts
│       │   └── session.ts
│       │
│       ├── store/                       # Zustand 状态管理
│       │   ├── profile.ts              # 连接配置状态
│       │   ├── session.ts              # 会话状态
│       │   └── settings.ts             # 设置状态
│       │
│       ├── hooks/
│       │   ├── useTerminal.ts          # xterm.js 封装
│       │   ├── useWebSocket.ts         # WebSocket 管理
│       │   └── useSession.ts           # 会话生命周期
│       │
│       ├── components/
│       │   ├── ui/                     # shadcn/ui 组件（CLI 自动生成）
│       │   │   ├── button.tsx
│       │   │   ├── input.tsx
│       │   │   ├── dialog.tsx
│       │   │   ├── sheet.tsx
│       │   │   ├── tabs.tsx
│       │   │   ├── scroll-area.tsx
│       │   │   ├── context-menu.tsx
│       │   │   ├── dropdown-menu.tsx
│       │   │   ├── tooltip.tsx
│       │   │   ├── badge.tsx
│       │   │   ├── separator.tsx
│       │   │   ├── skeleton.tsx
│       │   │   ├── command.tsx         # 命令面板（⌘K）
│       │   │   └── ...
│       │   │
│       │   ├── Layout/
│       │   │   ├── index.tsx           # 主布局（ResizablePanel）
│       │   │   └── StatusBar.tsx       # 底部状态栏
│       │   │
│       │   ├── Sidebar/
│       │   │   ├── index.tsx           # 侧边栏容器
│       │   │   ├── ProfileTree.tsx     # 分组树 + 连接列表
│       │   │   ├── ProfileItem.tsx     # 单个连接项
│       │   │   ├── GroupItem.tsx       # 单个分组项
│       │   │   └── SearchBar.tsx       # 搜索/过滤
│       │   │
│       │   ├── Terminal/
│       │   │   ├── index.tsx           # 终端容器
│       │   │   ├── TabBar.tsx          # Tab 栏（shadcn Tabs）
│       │   │   ├── Tab.tsx             # 单个 Tab
│       │   │   └── TerminalPane.tsx    # 单个终端面板
│       │   │
│       │   ├── ProfileForm/
│       │   │   ├── index.tsx           # 新建/编辑连接（shadcn Dialog）
│       │   │   ├── BasicSection.tsx    # 基本信息
│       │   │   ├── AuthSection.tsx     # 认证方式
│       │   │   ├── AdvancedSection.tsx # 高级选项（跳板机等）
│       │   │   └── TestButton.tsx      # 测试连接
│       │   │
│       │   ├── SnippetPanel/
│       │   │   ├── index.tsx           # 快捷命令面板
│       │   │   └── SnippetItem.tsx
│       │   │
│       │   ├── CommandPalette/         # ⌘K 命令面板
│       │   │   └── index.tsx
│       │   │
│       │   └── Settings/
│       │       ├── index.tsx           # 设置面板（shadcn Sheet）
│       │       └── ThemePicker.tsx     # 主题切换（明/暗/跟随系统）
│       │
│       └── lib/
│           └── utils.ts               # shadcn/ui 工具函数（cn()）
│
└── docs/
    └── DEVELOPMENT.md                  # 本文档
```

---

## 8. 模块详细设计

### 8.1 Session Service（会话管理核心）

```go
// service/session_service.go

type SessionService struct {
    sessions   map[string]*Session  // session_id → Session
    mu         sync.RWMutex
    maxPerUser int                  // 每用户最大会话数
}

type Session struct {
    ID          string
    ProfileID   string
    Driver      protocol.Driver
    Shell       protocol.Shell
    Status      SessionStatus
    CreatedAt   time.Time
    LastActiveAt time.Time
}

type SessionStatus string

const (
    SessionStatusConnecting  SessionStatus = "connecting"
    SessionStatusConnected   SessionStatus = "connected"
    SessionStatusDisconnected SessionStatus = "disconnected"
)

// 生命周期：
// Create → Connecting → Connected → Disconnected
//                  ↘ Error
```

### 8.2 WebSocket Hub（连接管理）

```go
// ws/hub.go

// Hub 管理所有 WebSocket 连接
type Hub struct {
    connections map[string]*Conn  // session_id → Conn
    mu          sync.RWMutex
}

// Conn 封装单个 WebSocket 连接
type Conn struct {
    sessionID string
    ws        *websocket.Conn
    send      chan []byte     // 发送缓冲区
    hub       *Hub
}

// 读写循环：
// ReadPump:  WS → session.Shell.Write()
// WritePump: session.Shell.Read() → WS
// 两个 goroutine + done channel 协调退出
```

### 8.3 Vault（凭据保险库）

```go
// store/vault_store.go

type VaultStore struct {
    db  *sql.DB
    key []byte  // AES-256 密钥，首次运行时生成
}

// 凭据存入 Vault 后，Profile 只存储 vault_id
// 删除 Profile 时，引用计数为 0 的 Vault 条目自动清理

func (s *VaultStore) Store(cred *model.Credential) (vaultID string, error)
func (s *VaultStore) Retrieve(vaultID string) (*model.Credential, error)
func (s *VaultStore) Delete(vaultID string) error
```

### 8.4 前端状态管理

```typescript
// store/session.ts
// 使用 Zustand 管理会话状态（轻量，适合此场景）

interface SessionStore {
  sessions: Map<string, Session>       // sessionId → Session
  activeSessionId: string | null

  createSession: (profileId: string) => Promise<string>
  closeSession: (sessionId: string) => void
  setActive: (sessionId: string) => void
  updateStatus: (sessionId: string, status: SessionStatus) => void
}
```

### 8.5 前端组件架构（shadcn/ui）

#### 组件层级

```
App
├── Layout (ResizablePanelGroup)
│   ├── Sidebar (ResizablePanel, 可拖拽调整宽度)
│   │   ├── SearchBar (Input + Command)
│   │   ├── ProfileTree (ScrollArea)
│   │   │   ├── GroupItem (Collapsible, 右键 ContextMenu)
│   │   │   └── ProfileItem (右键 ContextMenu, 双击连接)
│   │   └── 新建连接按钮 (Button)
│   │
│   └── MainContent (ResizablePanel)
│       ├── TabBar (Tabs, 可关闭)
│       │   └── Tab[] (每个会话一个 Tab)
│       └── Terminal[] (与 Tab 对应，隐藏非活跃的)
│
├── CommandPalette (⌘K, 搜索连接/命令/设置)
│
├── ProfileForm (Dialog)
│   ├── 基本信息（名称、主机、端口、用户名）
│   ├── 认证方式（密码 / 私钥）
│   ├── 分组和备注
│   └── 测试连接按钮
│
└── Settings (Sheet, 从右侧滑出)
    ├── 终端主题（明/暗/跟随系统）
    ├── 字体大小
    └── 字体族
```

#### shadcn/ui 组件映射

| 场景 | shadcn/ui 组件 | 说明 |
|------|----------------|------|
| 整体布局 | `ResizablePanelGroup` | 侧边栏可拖拽调整宽度 |
| 分组展开/折叠 | `Collapsible` | 分组树节点 |
| 右键菜单 | `ContextMenu` | 连接/分组右键操作 |
| 连接表单 | `Dialog` | 新建/编辑连接弹窗 |
| Tab 栏 | `Tabs` | 多会话切换 |
| 终端滚动 | `ScrollArea` | 侧边栏滚动 |
| 设置面板 | `Sheet` | 从右侧滑出的设置面板 |
| 命令面板 | `Command` | ⌘K 快速搜索连接/命令 |
| 连接状态 | `Badge` | 已连接/断开/连接中 |
| 操作反馈 | `Sonner (Toast)` | 操作成功/失败提示 |
| 加载骨架 | `Skeleton` | 列表加载占位 |
| 工具提示 | `Tooltip` | 图标按钮提示 |
| 下拉菜单 | `DropdownMenu` | 更多操作菜单 |
| 表单输入 | `Input` / `Label` | 表单字段 |
| 选择器 | `Select` | 分组选择、认证方式选择 |
| 开关 | `Switch` | 设置项开关 |
| 按钮 | `Button` | 操作按钮 |

#### shadcn/ui 初始化命令

```bash
cd web
npx shadcn@latest init
# 选择: React, Vite, TypeScript, Tailwind v4

# 按需添加组件
npx shadcn@latest add button input dialog sheet tabs scroll-area
npx shadcn@latest add context-menu dropdown-menu tooltip badge
npx shadcn@latest add command skeleton separator switch select label
npx shadcn@latest add resizable sonner
```

---

## 9. 开发里程碑

### M1：基础框架（预计 2 天）

- [ ] 初始化 Go 项目（go mod、分层目录结构）
- [ ] 初始化 React + Vite 6 + TypeScript 项目
- [ ] 初始化 Tailwind CSS v4（CSS-first 配置）
- [ ] 初始化 shadcn/ui（`npx shadcn@latest init`）
- [ ] 添加基础 shadcn/ui 组件（button、input、dialog、tabs 等）
- [ ] 后端：HTTP 服务 + Go 1.22+ 增强路由注册 + CORS + 日志中间件
- [ ] 后端：SQLite 初始化 + 迁移机制
- [ ] 后端：Store 接口定义 + Profile/Group/Vault Store 实现
- [ ] 前端：基础布局（ResizablePanelGroup 侧边栏 + 主内容区 + 状态栏）
- [ ] 前端：API Client 封装 + 类型定义
- [ ] 前端：Zustand store 初始化

### M2：连接管理（预计 2 天）

- [ ] 后端：Profile CRUD API
- [ ] 后端：Group CRUD API（树形结构）
- [ ] 后端：Vault 加密存储（AES-256-GCM）
- [ ] 后端：连接测试接口
- [ ] 前端：ProfileTree 分组树 + 连接列表
- [ ] 前端：ProfileForm（分步表单：基本 → 认证 → 高级）
- [ ] 前端：搜索/过滤

### M3：SSH 终端核心（预计 3 天）

- [ ] 后端：Protocol Driver 接口定义
- [ ] 后端：SSH Driver 实现（密码 + 密钥认证）
- [ ] 后端：Session Service（会话生命周期管理）
- [ ] 后端：WebSocket Hub（双向数据转发）
- [ ] 后端：心跳保活 + 会话超时清理
- [ ] 前端：xterm.js 集成 + addons（fit、web-links、search）
- [ ] 前端：useWebSocket + useTerminal hooks
- [ ] 前端：TabBar + 多终端管理
- [ ] 前端：终端自适应 + resize 同步

### M4：快捷命令 + 体验优化（预计 2 天）

- [ ] 后端：Snippet CRUD API
- [ ] 后端：审计日志记录
- [ ] 前端：SnippetPanel（搜索、执行、管理）
- [ ] 前端：终端主题切换（dark/light/自定义）
- [ ] 前端：字体/字号设置
- [ ] 前端：快捷键支持
- [ ] 前端：会话状态指示
- [ ] 前端：空状态 + Loading + 错误提示

### M5：打磨 + 上线准备（预计 2 天）

- [ ] 跳板机（Jump Host）支持
- [ ] 连接历史 / 最近使用
- [ ] 响应式布局适配
- [ ] 错误处理完善 + 用户友好提示
- [ ] 代码整理、注释
- [ ] 编写 README + 部署文档

---

## 10. 扩展预留清单

| 功能 | Phase | 预留设计 |
|------|-------|----------|
| SFTP 文件管理 | 2 | Driver 接口已有 Shell，补充 `FileSystem` 接口 |
| 会话录制回放 | 2 | Shell.Read 可 tee 到录制文件 |
| 端口转发 | 2 | Driver 接口补充 `Forward` 方法 |
| 串口连接 | 2 | 实现 `protocol/serial/driver.go` |
| 插件系统 | 3 | Service 层接口驱动，可动态注册 |
| 团队协作 | 3 | Profile 的 `shared` 字段 + 用户系统 |
| 云同步 | 3 | Store 层可替换为远程实现 |

---

## 11. 开发规范

### 11.1 后端

- 错误统一返回：`{"error": {"code": "...", "message": "..."}}`
- HTTP 状态码：200 成功 / 201 创建 / 204 删除 / 400 参数错误 / 401 未认证 / 404 不存在 / 500 服务端错误
- 时间格式：ISO 8601
- 日志：`log/slog`，结构化日志（Go 标准库）
- 路由：Go 1.22+ `net/http` 增强路由（`mux.HandleFunc("GET /api/profiles", ...)`）
- WebSocket：`github.com/coder/websocket`（支持 context.Context）
- 数据库迁移：使用版本号管理，启动时自动执行

### 11.2 前端

- 函数式组件 + Hooks（React 19 新特性：ref as prop、use() hook）
- 状态管理：Zustand 5+（轻量，TypeScript 友好）
- 样式：Tailwind CSS v4（CSS-first 配置，`@theme` 指令）
- UI 组件：shadcn/ui（按需引入，可自由修改源码）
- 组件按功能模块组织，每个模块独立目录
- shadcn/ui 组件放在 `components/ui/`，业务组件按功能分目录

### 11.3 Git

```
feat:     新功能
fix:      修复
refactor: 重构
docs:     文档
style:    样式
test:     测试
chore:    构建/工具
```
