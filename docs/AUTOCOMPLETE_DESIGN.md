# 终端命令补全设计

补全引擎分三层：静态命令、上下文参数和可取消的远端只读查询。前端实现位于
`web/src/lib/completionEngine.ts` 与 `web/src/hooks/useCompletion.ts`，Rust 执行入口位于
`src-tauri/src/ssh/session.rs`。

终端通过 `session_complete` command 提交 `request_id`、脚本和可选工作目录。Rust 在现有
SSH 连接上创建独立 exec channel，设置短超时并返回 `complete_response` Tauri event。
前端只接受当前请求 ID 的结果，因此旧查询、超时查询和切换标签后的结果不会污染菜单。

远端脚本必须只读，并由前端生成器白名单控制。Rust 对工作目录做 shell quoting；失败、
超时或连接关闭只会让动态补全降级，不影响终端 PTY。

验证重点：tokenize/quote、命令定位、缓存、请求竞态、超时丢弃、UTF-8 输出及工作目录转义。
