# 终端代码补全优化方案

## 目标

在不改变现有交互约束的前提下，优先提升终端代码补全的正确性、稳定性和可维护性：

- 保持 `Tab` 继续透传给远端 shell
- 保持前端 GUI 弹窗补全
- 保持动态候选通过只读远端 exec 获取
- 继续避免侵入式修改远端 shell 配置

## 本轮优化范围

### 1. 补全解析正确性

- 将补全 Spec 中“会消耗参数”的选项显式建模为 `Option.args`
- 修复 `git -C repo checkout`、`kubectl -n kube-system logs`、`docker exec -u root` 这类输入被误判层级的问题
- 清理历史 Spec 中重复或错误的层级定义
- 补齐 `--flag=value` 形式的参数补全链路

### 2. 动态查询生命周期

- 为远端动态补全查询增加超时与取消能力
- 避免同一 `script + cwd` 的重复在途请求
- 即使响应晚到，也允许回填缓存，减少后续重复查询

### 3. 输入缓冲与终端状态同步

- 在 stale 恢复时重建逻辑行，降低长命令补全错位概率
- 增强 TUI 检测，支持 `sudo vim` 这类前缀命令
- 优化 prompt 剥离启发式，降低误判风险

## 已落地改动

### 前端

- 重构 `web/src/lib/completionSpecs.ts`
  - Spec 结构统一为更清晰的层级格式
  - 关键 option 参数改为显式声明
  - 保留高频命令覆盖并补充动态能力
- 重构 `web/src/lib/completionEngine.ts`
  - 支持更接近 shell 行为的分词
  - 支持 option 参数消费与层级遍历
  - 支持静态参数与动态参数统一解析
  - 支持 `--flag=value` 形式的当前 token 解析、插入与动态生成器选择
- 重构 `web/src/hooks/useCompletion.ts`
  - 增加请求元数据与缓存回填
  - 合并静态/动态建议时去重
  - 避免同一动态请求重复发起
  - 根据引号状态决定是否自动追加空格
- 重构 `web/src/lib/completionBuffer.ts`
  - 支持逻辑行重建
  - 增强 TUI 检测
  - 优化 prompt 剥离
- 优化补全面板展示
  - 区分静态候选与动态候选来源标签

### 动态候选覆盖

- `systemctl` 常用服务操作支持动态服务名
- `git remote` 常用子命令支持动态远端名
- `npm run` 支持动态脚本名
- `kubectl`、文件路径等参数支持 `--flag=value` 形式补全

### 后端

- 扩展 `protocol.ContextCommandExecutor`
- 为 SSH 驱动实现 `ExecContext`
- 动态补全查询超时后可主动结束临时 session

### 测试

- 新增 `vitest` 前端单测基础设施
- 为补全引擎补充分词、参数消费、转义、引号、等号参数等测试
- 为终端输入缓冲补充 wrapped line、prompt、TUI 检测测试

## 本轮新增

- 已补齐 `--flag=value` 形式的参数补全链路
- 静态参数建议支持 `-o=json`、`--depth=1` 这类等号写法
- 动态参数建议支持 `--namespace=kube-system`、`--kubeconfig=./path` 这类等号写法
- 文件路径补全插入时仅补全 `=` 右侧缺失部分，避免重复插入 option 前缀

## 下一阶段建议

### 高优先级

- 为 `Option` 增加更强的元数据，例如 `valueStyle`、`repeatable`、`stopOptionParsing`
- 将动态补全协议从“前端直接传 shell 脚本”收敛为“前端传生成器 ID + 参数，后端白名单执行模板”
- 为文件路径补全替换掉对 `ls -F` 输出格式的强依赖
- 继续补齐补全核心逻辑的边界测试

### 中优先级

- 为动态补全缓存增加 LRU 与容量上限
- 为动态查询增加失败指标与调试日志
- 为候选排序增加“精确前缀优先、最近使用优先、静态/动态混排规则”

### 低优先级

- 评估是否按命令域拆分 Spec 文件，减少单文件维护成本
- 评估是否将动态补全能力下沉为更可复用的命令域插件机制
