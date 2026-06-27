# 终端自动补全功能设计方案

> 纯前端 GUI 弹窗补全 · 零服务器入侵 · 自建 Spec

---

## 1. 设计目标与硬约束

### 1.1 功能目标

为 XControl 的 Web 终端（xterm.js）接入**现代化 GUI 弹窗补全**，体验对标 Fig / Warp：

- 输入时自动弹出候选面板（命令 / 子命令 / 选项 / 动态候选）
- **↑/↓ 方向键选择，Enter 应用补全**（不使用 Tab）
- 动态候选（git 分支、文件路径、docker 容器）通过**只读远程查询**获取
- 服务器零改动、零安装、零注入

### 1.2 硬约束（用户明确）

| 约束 | 说明 |
|---|---|
| ❌ 行内灰色提示 | 不要 Fish/ble.sh 式 autosuggestion，只做弹窗 |
| ❌ Tab 键补全 | Tab 一律透传给远端 shell，避免与用户自有补全插件冲突 |
| ❌ 服务器入侵 | 不安装插件、不改 bashrc、不向 PTY stdin 注入 shell 配置 |
| ✅ 弹窗补全 | 前端渲染 GUI 浮动面板，↑/↓ 选择 + Enter 应用 |
| ✅ 只读查询 | 动态候选可经独立 SSH exec 执行只读命令（如 `git branch --list`），无副作用 |

### 1.3 路线取舍记录

- **shell 端注入（ble.sh / zsh-autosuggestions / bash-completion）**：排除。属服务器入侵（会话态注入），且产出的是行内灰色提示，与约束冲突。
- **更换 xterm.js**：排除。所有终端模拟器都是 PTY 渲染器，补全瓶颈不在渲染层；Tabby/Wave 等补全强的终端本身就用 xterm.js + shell 端注入。
- **Fig/Amazon Q 运行时**：排除。依赖 macOS Accessibility API、Fig 已 sunset（2024-09）、无 Web 版。但其 spec 数据格式可参考。
- **Fig spec 全量导入**：风险高（spec 用 Fig JS SDK，非纯数据；工具链已失修）。**起步自建精简 spec**，Fig 导入作为可选增强。

---

## 2. 架构设计

### 2.1 整体架构

```
┌──────────────────── 前端 (React + xterm.js) ────────────────────┐
│                                                                  │
│  useInputBuffer.ts   ← onData 解析,维护当前输入缓冲区+光标        │
│       │                                                          │
│       ▼                                                          │
│  completionEngine.ts ← 分词 → 匹配 Spec 树 → 生成建议             │
│       │                                                          │
│       ├─ 静态建议(命令/子命令/选项) → 直接返回                    │
│       └─ 动态 generator → WebSocket complete_request             │
│                                                                  │
│  CompletionPanel.tsx ← 浮动面板(↑/↓ 导航,Enter 应用)             │
│  (基于 xterm 光标像素坐标定位,光标下方)                           │
│                                                                  │
│  completionSpecs.ts  ← 自建精简 spec(git/docker/kubectl/...)     │
│  completionCache.ts  ← 分级 TTL 缓存                             │
│                                                                  │
└──────────────────────── WS 通道 ─────────────────────────────────│
                                 │                                  │
┌──────────────────── 后端 (Go) ──────────────────────────────────┐
│                                                                  │
│  ws.go readPump       ← 处理 complete_request                    │
│       │                                                          │
│       ▼                                                          │
│  completion.go        ← CommandExecutor.Exec 执行只读脚本         │
│       │                  (独立非交互 SSH 会话,不污染 PTY)         │
│       ▼                                                          │
│  返回 complete_response ← 原始 stdout                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
        ↓ SSH (只读 exec,远端零改动)
远端服务器: 零安装 / 零注入 / 零配置
```

### 2.2 与既有 OSC7 的关系

OSC7 cwd 追踪（`ws.go:401-417`）**已部署且非新增入侵**，补全直接复用其 CWD 字段用于文件路径补全的相对路径解析，无需新增任何服务器端逻辑。

### 2.3 补全三层优先级

```
用户输入(防抖) →
  Layer 1: 前端静态 Spec 匹配(0ms) →
    有动态 generator?
      Layer 2: 前端缓存命中(0ms) →
        Layer 3: WebSocket 远程只读 exec(目标<150ms,超时400ms丢弃)
```

---

## 3. 核心交互设计

### 3.1 触发方式:防抖自动弹出(无 Tab)

- 用户键入可打印字符后 **120ms 防抖**触发静态匹配
- 有匹配 → 弹出面板;无匹配 → 关闭面板
- 短输入(命令名 < 1 字符)不触发
- **Tab 永远透传**给远端 shell,不参与补全逻辑

### 3.2 键盘交互(关键)

| 键 | 面板开启时 | 面板关闭时 |
|---|---|---|
| 可打印字符 | 更新缓冲区,过滤候选,透传给 shell | 同左 |
| `↑` / `↓` | **拦截**:导航候选(不透传) | 透传给 shell(shell 历史),标记缓冲区 stale |
| `Enter` | **拦截**:应用选中候选(插入文本,不执行命令) | 透传给 shell(执行命令),清空缓冲区 |
| `Esc` | 关闭面板 | — |
| `Backspace` | 更新缓冲区,过滤候选,透传 | 同左 |
| `Tab` | 透传(用户自有补全) | 透传 |
| `Ctrl+C` | 关闭面板,清空缓冲区,透传 | 透传 |
| `Ctrl+R` / `↑↓`(关闭态) | — | 透传,标记 stale,隐藏面板直到下次 fresh 输入 |

### 3.3 应用补全的文本插入

用户已键入当前词前缀 `prefix`,选中建议 `suggestion.name`:

```
insertText = suggestion.name.slice(prefix.length)
// 子命令/选项补全后追加空格,便于继续补全下一级
if (type === 'subcommand' || type === 'option') insertText += ' '
sendInput(insertText)   // 写入 SSH stdin,shell 在光标处插入
```

- 面板开启态 Enter 只插入文本,**不发送 `\r`**,命令不执行
- 用户可再按一次 Enter 执行,或继续补全下一级
- 假设:fresh 输入时光标在行尾(shell cursor 与缓冲区 cursor 同步)。若用户用 `←` 移动光标,标记 stale 并隐藏面板,避免插入位置错乱

### 3.4 输入缓冲区追踪(onData)

**设计原则**:只在 fresh 输入窗口追踪,历史/搜索态/TUI 态直接降级为"隐藏面板"而非"不可靠同步"。

| onData 输入 | 处理 |
|---|---|
| 可打印字符 | 在 cursor 处插入,cursor++;若 stale 则先从 xterm buffer 重建 |
| `\x7f` Backspace | 删除 cursor 前一字符,cursor--;若 stale 则先重建 |
| `\x1b[C` → / `\x1b[D` ← | **在 fresh 行内追踪光标偏移**,不直接 stale;越界才 stale |
| `\r` Enter | 面板开→应用;面板关→reset,并检测执行的命令是否为 TUI 命令 |
| `\x1b[A` ↑ / `\x1b[B` ↓ | 面板开→导航;面板关→标记 stale,隐藏面板(切换 shell 历史) |
| `\x03` Ctrl+C | reset,关闭面板,退出 TUI 模式 |
| `\x17` Ctrl+W | 删除前一词;若 stale 则先重建 |
| `\x15` Ctrl+U | 清空至行首;若 stale 则先重建 |
| `\t` Tab | 忽略(透传由上层处理) |
| 其他控制字符 | 标记 stale,隐藏面板 |

**TUI 期间禁用**:终端输出中出现 `ESC [ ?1049 h`(进入 alternate buffer)或用户执行 vim/htop/less 等命令时,`inTuiRef` 置 true,补全完全禁用。退出 TUI 时 `ESC [ ?1049 l` 或 Ctrl+C 后恢复。

**stale 恢复优化**:用户下一次键入可打印字符时,从 xterm buffer 当前行重建缓冲区。prompt 剥离改进为:
- 从右向左扫描,找到最后一个 `$`/`#`/`%`/`>` **且后接空格或行尾**的结束符;
- 若该结束符位于行首 30% 以内(可能是路径中的 `$`),继续向左找第二个候选;
- 没找到则整行当作用户输入(极简 prompt 场景)。
这样可正确剥离 `(main)$` / `[12:34:56]$` / `~/$projects$` 等复杂 prompt。

---

## 4. 数据结构

### 4.1 自建 Spec 格式(精简 JSON,非 Fig 格式)

```typescript
// web/src/lib/completionSpecs.ts

interface Spec {
  name: string                       // 命令名,如 "git"
  description?: string
  subcommands?: Subcommand[]
  options?: Option[]
  args?: Arg                         // 位置参数定义
}

interface Subcommand {
  name: string
  description?: string
  options?: Option[]
  args?: Arg
  subcommands?: Subcommand[]         // 递归
}

interface Option {
  name: string                       // 如 "-m" 或 "--message"
  description?: string
  args?: Arg
}

interface Arg {
  name?: string
  description?: string
  // 动态候选:在远端执行的只读脚本 + 前端后处理
  generator?: {
    script: string                   // 如 "git branch --list"
    cacheTtl?: number                // ms,默认 10000
  }
  // 静态候选
  suggestions?: { name: string; description?: string }[]
}
```

**起步覆盖**:git、docker、kubectl、npm、ssh、systemctl、ls、cd、cat、grep、find(约 15-20 个高频 CLI),完全自建、完全可控、无外部依赖。

### 4.2 WebSocket 消息扩展

```jsonc
// 客户端 → 服务端
{
  "type": "complete_request",
  "payload": {
    "request_id": "短id",
    "script": "git branch --list",
    "cwd": "/home/user/project"
  }
}

// 服务端 → 客户端
{
  "type": "complete_response",
  "payload": {
    "request_id": "短id",
    "output": "main\ndevelop\nfeature/x",
    "error": "",
    "exit_code": 0
  }
}
```

后端在独立非交互 SSH 会话执行(`CommandExecutor.Exec`,见 `driver.go:117`),不影响 PTY。若 `cwd` 非空,脚本前拼接 `cd {cwd} &&`。400ms 硬超时。

---

## 5. POC 范围(当前阶段)

POC 目标:验证核心闭环可行性,不包含动态查询。

| 包含 | 不包含(后续阶段) |
|---|---|
| 自建 git spec(子命令+选项) | 远程 dynamic generator |
| onData 输入缓冲区追踪 | WebSocket complete 协议 |
| 分词 + Spec 树匹配 | 缓存、shell 检测 |
| 浮动面板(光标下方定位) | Settings UI、Profile shell_type |
| ↑/↓ 导航 + Enter 应用 | 多 spec 懒加载、Fig 导入 |
| Tab 透传、stale 降级 | 文件路径补全 |

### POC 验收标准

1. 连接 SSH 服务器,键入 `git` + 空格 → 自动弹出子命令列表
2. 键入 `co` → 面板过滤为 `commit` / `checkout`
3. `↑/↓` 导航,`Enter` 应用,行内正确插入文本,命令不执行
4. `Tab` 透传,触发远端 shell 自有补全
5. `↑/↓`(面板关)正常切换 shell 历史,面板不误弹
6. `Esc` / `Ctrl+C` 关闭面板

### POC 文件清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `web/src/lib/completionSpecs.ts` | 新建 | Spec 类型 + git spec + 顶层命令索引 |
| `web/src/lib/completionEngine.ts` | 新建 | 分词 + Spec 树遍历 + 前缀匹配 |
| `web/src/hooks/useCompletion.ts` | 新建 | onData 追踪 + 面板状态 + 应用逻辑 |
| `web/src/lib/completionBuffer.ts` | 新建 | prompt 剥离 + stale 恢复 + TUI 检测 |
| `web/src/components/Terminal/CompletionPanel.tsx` | 新建 | 浮动面板 UI |
| `web/src/hooks/useTerminal.ts` | 修改 | 暴露 `getTerminal()` |
| `web/src/components/Terminal/TerminalPane.tsx` | 修改 | 接入 useCompletion,拦截 onData |

---

## 6. 后续阶段(POC 验证通过后)

| 阶段 | 任务 |
|---|---|
| 动态查询 | WebSocket complete 协议、后端 completion.go、缓存 |
| Spec 扩充 | 扩到 15-20 个高频 CLI,含 dynamic generator |
| 健壮性 | prompt 剥离边界、TUI 期间禁用、stale 恢复 ✅ 已完成 |
| 设置集成 | 接 `terminalPopupMenu` 开关、Profile shell_type |
| 可选增强 | 评估 Fig spec 导入可行性(先验证 git/docker/kubectl 编译管线) |

---

## 7. 错误兜底

**核心原则**:补全永不阻塞用户输入。

| 场景 | 处理 |
|---|---|
| Spec 未命中 | 不弹面板,输入正常透传 |
| 远程查询超时(>400ms) | 丢弃,不显示动态候选 |
| 远程查询报错 | 静默,控制台 warn |
| 缓冲区 stale | 隐藏面板,等下次 fresh 输入重建 |
| WebSocket 断开 | 补全不可用,终端正常 |
| Tab | 永远透传,不被补全拦截 |
| 进入 TUI(vim/htop/less) | `ESC[?1049h` 或命令检测触发禁用,退出后恢复 |
| prompt 含 $/#/%/> 等字符 | 从右向左扫描+30% 防御,避免路径中的字符被误判 |
