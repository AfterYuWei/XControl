// 自建补全 Spec(精简格式,非 Fig 格式)
// POC 起步:覆盖 git + 顶层命令索引

export type SuggestionType = 'command' | 'subcommand' | 'option' | 'arg'

export interface Suggestion {
  name: string
  description?: string
  type: SuggestionType
}

export interface Arg {
  name?: string
  description?: string
  generator?: {
    script: string
    cacheTtl?: number
    parser?: 'git-branch' | 'docker-ps' | 'kubectl-name'
  }
  suggestions?: { name: string; description?: string }[]
}

export interface Option {
  name: string
  description?: string
  args?: Arg
}

export interface Subcommand {
  name: string
  description?: string
  options?: Option[]
  args?: Arg
  subcommands?: Subcommand[]
}

export interface Spec {
  name: string
  description?: string
  subcommands?: Subcommand[]
  options?: Option[]
  args?: Arg
}

const gitSpec: Spec = {
  name: 'git',
  description: '分布式版本控制系统',
  options: [
    { name: '--version', description: '显示版本' },
    { name: '--help', description: '显示帮助' },
    { name: '-C', description: '切换到指定目录' },
  ],
  subcommands: [
    { name: 'add', description: '添加文件到暂存区', options: [
      { name: '-A', description: '添加所有变更' },
      { name: '-u', description: '仅添加已跟踪文件' },
      { name: '-p', description: '交互式暂存' },
    ]},
    { name: 'commit', description: '提交暂存区到仓库', options: [
      { name: '-m', description: '提交信息' },
      { name: '--amend', description: '修改上次提交' },
      { name: '-a', description: '自动暂存已跟踪文件' },
    ]},
    { name: 'push', description: '推送提交到远端', options: [
      { name: '-u', description: '设置上游' },
      { name: '-f', description: '强制推送' },
      { name: '--tags', description: '推送标签' },
    ]},
    { name: 'pull', description: '拉取并合并远端', options: [
      { name: '--rebase', description: '变基而非合并' },
      { name: '--no-commit', description: '不自动提交' },
    ]},
    { name: 'checkout', description: '切换分支或恢复文件', options: [
      { name: '-b', description: '创建并切换分支' },
      { name: '-B', description: '强制创建分支' },
    ], args: {
      generator: { script: 'git branch --list', cacheTtl: 5000, parser: 'git-branch' },
    }},
    { name: 'branch', description: '列出/创建/删除分支', options: [
      { name: '-a', description: '所有分支' },
      { name: '-d', description: '删除分支' },
      { name: '-m', description: '重命名分支' },
    ]},
    { name: 'merge', description: '合并分支', options: [
      { name: '--no-ff', description: '强制创建合并提交' },
      { name: '--squash', description: '压缩合并' },
    ], args: {
      generator: { script: 'git branch --list', cacheTtl: 5000, parser: 'git-branch' },
    }},
    { name: 'rebase', description: '变基到指定分支', options: [
      { name: '-i', description: '交互式变基' },
      { name: '--abort', description: '中止变基' },
    ], args: {
      generator: { script: 'git branch --list', cacheTtl: 5000, parser: 'git-branch' },
    }},
    { name: 'switch', description: '切换分支(git 2.23+)', options: [
      { name: '-c', description: '创建并切换分支' },
      { name: '--detach', description: '分离 HEAD' },
    ], args: {
      generator: { script: 'git branch --list', cacheTtl: 5000, parser: 'git-branch' },
    }},
    { name: 'log', description: '查看提交历史', options: [
      { name: '--oneline', description: '单行显示' },
      { name: '--graph', description: '图形显示' },
      { name: '-p', description: '显示 diff' },
    ]},
    { name: 'status', description: '查看工作区状态', options: [{ name: '-s', description: '简洁格式' }] },
    { name: 'clone', description: '克隆仓库', options: [
      { name: '--depth', description: '浅克隆深度' },
      { name: '--recursive', description: '递归子模块' },
    ]},
    { name: 'init', description: '初始化仓库', options: [{ name: '--bare', description: '裸仓库' }] },
    { name: 'stash', description: '暂存工作区', options: [
      { name: 'list', description: '列出暂存' },
      { name: 'pop', description: '恢复最近暂存' },
    ]},
    { name: 'fetch', description: '拉取远端对象', options: [
      { name: '--all', description: '所有远端' },
      { name: '--tags', description: '拉取标签' },
    ]},
    { name: 'remote', description: '管理远端', options: [
      { name: '-v', description: '显示 URL' },
      { name: 'add', description: '添加远端' },
    ]},
  ],
}

const dockerSpec: Spec = {
  name: 'docker',
  description: '容器引擎',
  options: [
    { name: '--help', description: '显示帮助' },
    { name: '--version', description: '显示版本' },
    { name: '-H', description: '指定 Docker daemon 地址' },
  ],
  subcommands: [
    { name: 'run', description: '创建并启动容器', options: [
      { name: '-d', description: '后台运行' },
      { name: '-it', description: '交互模式 + TTY' },
      { name: '--name', description: '容器名称' },
      { name: '-p', description: '端口映射 host:container' },
      { name: '-v', description: '挂载卷 host:container' },
      { name: '-e', description: '环境变量' },
      { name: '--rm', description: '退出后自动删除' },
      { name: '--network', description: '指定网络' },
    ]},
    { name: 'ps', description: '列出容器', options: [
      { name: '-a', description: '包含已停止的容器' },
      { name: '-q', description: '只显示 ID' },
      { name: '--format', description: '格式化输出' },
    ]},
    { name: 'images', description: '列出镜像', options: [
      { name: '-a', description: '包含中间层' },
      { name: '-q', description: '只显示 ID' },
    ]},
    { name: 'exec', description: '在运行中的容器执行命令', options: [
      { name: '-it', description: '交互模式 + TTY' },
      { name: '-u', description: '指定用户' },
      { name: '--privileged', description: '特权模式' },
    ]},
    { name: 'logs', description: '查看容器日志', options: [
      { name: '-f', description: '持续跟踪' },
      { name: '--tail', description: '显示最后 N 行' },
      { name: '-t', description: '显示时间戳' },
    ], args: {
      generator: { script: "docker ps -a --format '{{.ID}}\\t{{.Names}}'", cacheTtl: 3000, parser: 'docker-ps' },
    }},
    { name: 'stop', description: '停止容器', args: {
      generator: { script: "docker ps -a --format '{{.ID}}\\t{{.Names}}'", cacheTtl: 3000, parser: 'docker-ps' },
    }},
    { name: 'start', description: '启动容器', args: {
      generator: { script: "docker ps -a --format '{{.ID}}\\t{{.Names}}'", cacheTtl: 3000, parser: 'docker-ps' },
    }},
    { name: 'restart', description: '重启容器', args: {
      generator: { script: "docker ps -a --format '{{.ID}}\\t{{.Names}}'", cacheTtl: 3000, parser: 'docker-ps' },
    }},
    { name: 'rm', description: '删除容器', options: [
      { name: '-f', description: '强制删除运行中的容器' },
      { name: '-v', description: '同时删除匿名卷' },
    ], args: {
      generator: { script: "docker ps -a --format '{{.ID}}\\t{{.Names}}'", cacheTtl: 3000, parser: 'docker-ps' },
    }},
    { name: 'exec', description: '在运行中的容器执行命令', options: [
      { name: '-it', description: '交互模式 + TTY' },
      { name: '-u', description: '指定用户' },
      { name: '--privileged', description: '特权模式' },
    ], args: {
      generator: { script: "docker ps --format '{{.ID}}\\t{{.Names}}'", cacheTtl: 3000, parser: 'docker-ps' },
    }},
    { name: 'rmi', description: '删除镜像', options: [{ name: '-f', description: '强制删除' }] },
    { name: 'build', description: '构建镜像', options: [
      { name: '-t', description: '镜像名称:标签' },
      { name: '-f', description: '指定 Dockerfile' },
      { name: '--no-cache', description: '不使用缓存' },
    ]},
    { name: 'pull', description: '拉取镜像' },
    { name: 'push', description: '推送镜像' },
    { name: 'inspect', description: '查看详细信息', args: {
      generator: { script: "docker ps -a --format '{{.ID}}\\t{{.Names}}'", cacheTtl: 3000, parser: 'docker-ps' },
    }},
    { name: 'stats', description: '资源使用统计', options: [{ name: '--no-stream', description: '只输出一次' }], args: {
      generator: { script: "docker ps --format '{{.ID}}\\t{{.Names}}'", cacheTtl: 3000, parser: 'docker-ps' },
    }},
    { name: 'container', description: '管理容器', subcommands: [
      { name: 'ls', description: '列出容器' },
      { name: 'prune', description: '清理停止的容器' },
    ]},
    { name: 'image', description: '管理镜像', subcommands: [
      { name: 'ls', description: '列出镜像' },
      { name: 'prune', description: '清理未使用镜像' },
    ]},
    { name: 'volume', description: '管理卷', subcommands: [
      { name: 'ls', description: '列出卷' },
      { name: 'create', description: '创建卷' },
      { name: 'rm', description: '删除卷' },
      { name: 'prune', description: '清理未使用卷' },
    ]},
    { name: 'network', description: '管理网络', subcommands: [
      { name: 'ls', description: '列出网络' },
      { name: 'create', description: '创建网络' },
      { name: 'rm', description: '删除网络' },
    ]},
    { name: 'compose', description: 'Docker Compose' },
    { name: 'login', description: '登录镜像仓库' },
    { name: 'logout', description: '登出镜像仓库' },
    { name: 'info', description: '显示系统信息' },
    { name: 'version', description: '显示版本' },
  ],
}

// k8s 常用资源类型,用于 get/describe/delete/edit/scale/rollout 等子命令
const k8sResourceTypes: Subcommand[] = [
  { name: 'pods', description: 'Pod', args: { generator: { script: 'kubectl get pods -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'deployments', description: 'Deployment', args: { generator: { script: 'kubectl get deployments -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'services', description: 'Service', args: { generator: { script: 'kubectl get services -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'configmaps', description: 'ConfigMap', args: { generator: { script: 'kubectl get configmaps -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'secrets', description: 'Secret', args: { generator: { script: 'kubectl get secrets -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'nodes', description: 'Node', args: { generator: { script: 'kubectl get nodes -o name', cacheTtl: 10000, parser: 'kubectl-name' } } },
  { name: 'namespaces', description: 'Namespace', args: { generator: { script: 'kubectl get namespaces -o name', cacheTtl: 10000, parser: 'kubectl-name' } } },
  { name: 'ingresses', description: 'Ingress', args: { generator: { script: 'kubectl get ingresses -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'jobs', description: 'Job', args: { generator: { script: 'kubectl get jobs -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'cronjobs', description: 'CronJob', args: { generator: { script: 'kubectl get cronjobs -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'statefulsets', description: 'StatefulSet', args: { generator: { script: 'kubectl get statefulsets -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'daemonsets', description: 'DaemonSet', args: { generator: { script: 'kubectl get daemonsets -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'replicasets', description: 'ReplicaSet', args: { generator: { script: 'kubectl get replicasets -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'persistentvolumeclaims', description: 'PVC', args: { generator: { script: 'kubectl get persistentvolumeclaims -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'serviceaccounts', description: 'ServiceAccount', args: { generator: { script: 'kubectl get serviceaccounts -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'events', description: 'Event', args: { generator: { script: 'kubectl get events -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
]

const kubectlSpec: Spec = {
  name: 'kubectl',
  description: 'Kubernetes CLI',
  options: [
    { name: '--help', description: '显示帮助' },
    { name: '-n', description: '指定命名空间' },
    { name: '--namespace', description: '指定命名空间' },
    { name: '--kubeconfig', description: '指定 kubeconfig 文件' },
    { name: '-o', description: '输出格式' },
    { name: '-v', description: '日志级别' },
  ],
  subcommands: [
    { name: 'get', description: '获取资源', options: [
      { name: '-n', description: '命名空间' },
      { name: '--namespace', description: '指定命名空间' },
      { name: '-o', description: '输出格式' },
      { name: '-w', description: '持续监听' },
      { name: '--all-namespaces', description: '所有命名空间' },
    ], subcommands: k8sResourceTypes },
    { name: 'describe', description: '描述资源详情', subcommands: k8sResourceTypes },
    { name: 'logs', description: '查看日志', options: [
      { name: '-n', description: '命名空间' },
      { name: '--namespace', description: '指定命名空间' },
      { name: '-f', description: '持续跟踪' },
      { name: '--tail', description: '最后 N 行' },
      { name: '-p', description: '上一个容器' },
      { name: '--previous', description: '上一个容器' },
    ], args: { generator: { script: 'kubectl get pods -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
    { name: 'exec', description: '进入容器', options: [
      { name: '-n', description: '命名空间' },
      { name: '--namespace', description: '指定命名空间' },
      { name: '-it', description: '交互模式 + TTY' },
      { name: '--', description: '分隔符' },
    ], args: { generator: { script: 'kubectl get pods -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
    { name: 'apply', description: '应用配置', options: [
      { name: '-f', description: '文件或目录' },
      { name: '-k', description: 'kustomization 目录' },
      { name: '--dry-run', description: '试运行' },
    ]},
    { name: 'delete', description: '删除资源', options: [
      { name: '-f', description: '文件' },
      { name: '--grace-period', description: '优雅终止时间' },
    ], subcommands: k8sResourceTypes },
    { name: 'create', description: '创建资源' },
    { name: 'edit', description: '编辑资源', subcommands: k8sResourceTypes },
    { name: 'scale', description: '扩缩容', subcommands: k8sResourceTypes },
    { name: 'port-forward', description: '端口转发', options: [
      { name: '-n', description: '命名空间' },
      { name: '--namespace', description: '指定命名空间' },
    ], args: { generator: { script: 'kubectl get pods -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
    { name: 'rollout', description: '滚动管理', subcommands: [
      { name: 'status', description: '查看状态', subcommands: k8sResourceTypes },
      { name: 'undo', description: '回滚', subcommands: k8sResourceTypes },
      { name: 'history', description: '历史版本', subcommands: k8sResourceTypes },
      { name: 'restart', description: '重启', subcommands: k8sResourceTypes },
    ]},
    { name: 'cluster-info', description: '集群信息' },
    { name: 'top', description: '资源使用', subcommands: [
      { name: 'nodes', description: '节点资源', args: { generator: { script: 'kubectl top node --no-headers | awk "{print \$1}"', cacheTtl: 5000, parser: 'git-branch' } } },
      { name: 'pods', description: 'Pod 资源', args: { generator: { script: 'kubectl top pod --no-headers -n {{namespace}} | awk "{print \$1}"', cacheTtl: 5000, parser: 'git-branch' } } },
    ]},
    { name: 'config', description: '配置管理', subcommands: [
      { name: 'view', description: '查看配置' },
      { name: 'use-context', description: '切换上下文', args: { generator: { script: 'kubectl config get-contexts -o name', cacheTtl: 10000, parser: 'git-branch' } } },
      { name: 'get-contexts', description: '列出上下文' },
      { name: 'current-context', description: '当前上下文' },
    ]},
    { name: 'namespace', description: '命名空间', args: { generator: { script: 'kubectl get namespaces -o name', cacheTtl: 10000, parser: 'kubectl-name' } } },
    { name: 'version', description: '版本信息' },
    { name: 'explain', description: '资源文档' },
    { name: 'cp', description: '复制文件' },
  ],
}

const npmSpec: Spec = {
  name: 'npm',
  description: 'Node 包管理',
  options: [
    { name: '--help', description: '显示帮助' },
    { name: '--version', description: '显示版本' },
  ],
  subcommands: [
    { name: 'install', description: '安装依赖', options: [
      { name: '-g', description: '全局安装' },
      { name: '--save-dev', description: '开发依赖' },
      { name: '-D', description: '开发依赖' },
      { name: '--save-prod', description: '生产依赖' },
      { name: '-P', description: '生产依赖' },
      { name: '--no-save', description: '不写入 package.json' },
      { name: '--force', description: '强制' },
      { name: '--legacy-peer-deps', description: '忽略 peer 依赖冲突' },
    ]},
    { name: 'uninstall', description: '卸载包', options: [
      { name: '-g', description: '全局' },
      { name: '-D', description: '从开发依赖移除' },
    ]},
    { name: 'update', description: '更新依赖' },
    { name: 'run', description: '运行脚本' },
    { name: 'init', description: '初始化项目', options: [
      { name: '-y', description: '使用默认值' },
    ]},
    { name: 'publish', description: '发布包' },
    { name: 'version', description: '版本管理' },
    { name: 'list', description: '列出已装包', options: [
      { name: '-g', description: '全局' },
      { name: '--depth', description: '依赖深度' },
    ]},
    { name: 'audit', description: '安全审计', options: [
      { name: 'fix', description: '自动修复' },
    ]},
    { name: 'login', description: '登录' },
    { name: 'logout', description: '登出' },
    { name: 'config', description: '配置管理', subcommands: [
      { name: 'get', description: '读取配置' },
      { name: 'set', description: '设置配置' },
      { name: 'list', description: '列出配置' },
      { name: 'delete', description: '删除配置' },
    ]},
    { name: 'cache', description: '缓存管理', subcommands: [
      { name: 'clean', description: '清理缓存' },
      { name: 'verify', description: '验证缓存' },
    ]},
    { name: 'start', description: '运行 start 脚本' },
    { name: 'test', description: '运行 test 脚本' },
    { name: 'ci', description: '干净安装(锁定版本)' },
  ],
}

const systemctlSpec: Spec = {
  name: 'systemctl',
  description: 'systemd 服务管理',
  options: [
    { name: '--help', description: '显示帮助' },
    { name: '--user', description: '用户级服务' },
    { name: '--now', description: '同时启动/停止' },
    { name: '--type', description: '按类型过滤' },
    { name: '-t', description: '按类型过滤' },
    { name: '--all', description: '包含未激活' },
    { name: '--no-pager', description: '禁用分页' },
  ],
  subcommands: [
    { name: 'start', description: '启动服务' },
    { name: 'stop', description: '停止服务' },
    { name: 'restart', description: '重启服务' },
    { name: 'reload', description: '重载配置' },
    { name: 'status', description: '查看状态' },
    { name: 'enable', description: '开机启用', options: [
      { name: '--now', description: '同时启动' },
    ]},
    { name: 'disable', description: '开机禁用' },
    { name: 'is-active', description: '是否运行中' },
    { name: 'is-enabled', description: '是否开机启用' },
    { name: 'is-failed', description: '是否失败' },
    { name: 'list-units', description: '列出单元', options: [
      { name: '--type', description: '类型过滤' },
      { name: '--state', description: '状态过滤' },
      { name: '--all', description: '包含未激活' },
    ]},
    { name: 'list-unit-files', description: '列出单元文件' },
    { name: 'daemon-reload', description: '重载 systemd 配置' },
    { name: 'daemon-reexec', description: '重新执行 systemd' },
    { name: 'edit', description: '编辑单元覆盖', options: [
      { name: '--full', description: '编辑完整文件' },
    ]},
    { name: 'cat', description: '查看单元文件' },
    { name: 'show', description: '显示单元属性' },
    { name: 'mask', description: '屏蔽服务' },
    { name: 'unmask', description: '取消屏蔽' },
    { name: 'reset-failed', description: '重置失败状态' },
  ],
}

// 顶层命令索引(用于第一个 token 补全)
const commandIndex: { name: string; description: string }[] = [
  { name: 'git', description: '分布式版本控制' },
  { name: 'docker', description: '容器引擎' },
  { name: 'kubectl', description: 'Kubernetes CLI' },
  { name: 'npm', description: 'Node 包管理' },
  { name: 'ls', description: '列出目录' },
  { name: 'cd', description: '切换目录' },
  { name: 'cat', description: '查看文件' },
  { name: 'grep', description: '文本搜索' },
  { name: 'find', description: '查找文件' },
  { name: 'ssh', description: '远程登录' },
  { name: 'systemctl', description: '服务管理' },
  { name: 'vim', description: '编辑器' },
]

const specMap: Record<string, Spec> = {
  git: gitSpec,
  docker: dockerSpec,
  kubectl: kubectlSpec,
  npm: npmSpec,
  systemctl: systemctlSpec,
}

export function getSpec(command: string): Spec | undefined {
  return specMap[command]
}

export function getCommandIndex() {
  return commandIndex
}
