// 自建补全 Spec（精简数据格式，非 Fig 运行时格式）

export type SuggestionType = 'command' | 'subcommand' | 'option' | 'arg' | 'directory' | 'history'
export type SuggestionOrigin = 'static' | 'dynamic'

export interface Suggestion {
  name: string
  /** 可选的显示名（如末级目录只显示目录名，不含完整路径）；缺省时显示 name */
  displayName?: string
  description?: string
  type: SuggestionType
  origin?: SuggestionOrigin
  /** directory 类型：是否为可展开子菜单的目录（false 表示文件） */
  isDir?: boolean
  /** history 类型：历史命令执行次数（如 ×4） */
  count?: number
  /** history 类型：完整历史命令（应用时整条插入） */
  fullCommand?: string
}

export interface Arg {
  name?: string
  description?: string
  generator?: {
    script: string
    cacheTtl?: number
    parser?: 'git-branch' | 'docker-ps' | 'kubectl-name' | 'line-list'
  }
  fileGenerator?: {
    dirsOnly?: boolean
    cacheTtl?: number
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

const namespaceArg: Arg = {
  generator: {
    script: 'kubectl get namespaces -o name',
    cacheTtl: 10000,
    parser: 'kubectl-name',
  },
}

const outputFormatArg: Arg = {
  suggestions: [
    { name: 'name', description: '资源名称' },
    { name: 'json', description: 'JSON 输出' },
    { name: 'yaml', description: 'YAML 输出' },
    { name: 'wide', description: '扩展列输出' },
  ],
}

const fileArg = (dirsOnly = false): Arg => ({
  fileGenerator: { dirsOnly, cacheTtl: 3000 },
})

const lineListArg = (script: string, cacheTtl = 5000): Arg => ({
  generator: {
    script,
    cacheTtl,
    parser: 'line-list',
  },
})

const gitBranchArg: Arg = {
  generator: { script: 'git branch --list', cacheTtl: 5000, parser: 'git-branch' },
}

const gitRemoteArg: Arg = lineListArg('git remote', 5000)

const dockerContainerArg = (all = false): Arg => ({
  generator: {
    script: all ? "docker ps -a --format '{{.ID}}\\t{{.Names}}'" : "docker ps --format '{{.ID}}\\t{{.Names}}'",
    cacheTtl: 3000,
    parser: 'docker-ps',
  },
})

const kubectlPodArg: Arg = {
  generator: { script: 'kubectl get pods -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' },
}

const systemdServiceUnitsArg = lineListArg(`systemctl list-unit-files --type=service --no-pager --no-legend 2>/dev/null | awk '{print $1}'`, 10000)
const systemdActiveUnitsArg = lineListArg(`systemctl list-units --type=service --no-pager --no-legend 2>/dev/null | awk '{print $1}'`, 10000)
const systemdFailedUnitsArg = lineListArg(`systemctl list-units --state=failed --type=service --no-pager --no-legend 2>/dev/null | awk '{print $1}'`, 10000)

const npmScriptArg = lineListArg(`node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));for(const key of Object.keys((p&&p.scripts)||{})){console.log(key)}"`, 10000)

const k8sResourceTypes: Subcommand[] = [
  { name: 'pods', description: 'Pod', args: kubectlPodArg },
  { name: 'deployments', description: 'Deployment', args: { generator: { script: 'kubectl get deployments -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'services', description: 'Service', args: { generator: { script: 'kubectl get services -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'configmaps', description: 'ConfigMap', args: { generator: { script: 'kubectl get configmaps -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'secrets', description: 'Secret', args: { generator: { script: 'kubectl get secrets -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'nodes', description: 'Node', args: { generator: { script: 'kubectl get nodes -o name', cacheTtl: 10000, parser: 'kubectl-name' } } },
  { name: 'namespaces', description: 'Namespace', args: namespaceArg },
  { name: 'ingresses', description: 'Ingress', args: { generator: { script: 'kubectl get ingresses -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'jobs', description: 'Job', args: { generator: { script: 'kubectl get jobs -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'cronjobs', description: 'CronJob', args: { generator: { script: 'kubectl get cronjobs -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'statefulsets', description: 'StatefulSet', args: { generator: { script: 'kubectl get statefulsets -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'daemonsets', description: 'DaemonSet', args: { generator: { script: 'kubectl get daemonsets -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'replicasets', description: 'ReplicaSet', args: { generator: { script: 'kubectl get replicasets -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'persistentvolumeclaims', description: 'PVC', args: { generator: { script: 'kubectl get persistentvolumeclaims -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
  { name: 'serviceaccounts', description: 'ServiceAccount', args: { generator: { script: 'kubectl get serviceaccounts -o name -n {{namespace}}', cacheTtl: 3000, parser: 'kubectl-name' } } },
]

const gitSpec: Spec = {
  name: 'git',
  description: '分布式版本控制',
  options: [
    { name: '--version', description: '显示版本' },
    { name: '--help', description: '显示帮助' },
    { name: '-C', description: '切换工作目录', args: fileArg(true) },
  ],
  subcommands: [
    { name: 'add', description: '添加文件到暂存区', options: [{ name: '-A' }, { name: '-u' }, { name: '-p' }], args: fileArg() },
    { name: 'commit', description: '提交暂存区', options: [{ name: '-m', args: { name: 'message' } }, { name: '--amend' }, { name: '-a' }] },
    { name: 'push', description: '推送提交', options: [{ name: '-u' }, { name: '-f' }, { name: '--tags' }] },
    { name: 'pull', description: '拉取并合并', options: [{ name: '--rebase' }, { name: '--no-commit' }] },
    { name: 'checkout', description: '切换分支或恢复文件', options: [{ name: '-b' }, { name: '-B' }], args: gitBranchArg },
    { name: 'branch', description: '管理分支', options: [{ name: '-a' }, { name: '-d' }, { name: '-m' }], args: gitBranchArg },
    { name: 'merge', description: '合并分支', options: [{ name: '--no-ff' }, { name: '--squash' }], args: gitBranchArg },
    { name: 'rebase', description: '变基', options: [{ name: '-i' }, { name: '--abort' }], args: gitBranchArg },
    { name: 'switch', description: '切换分支', options: [{ name: '-c' }, { name: '--detach' }], args: gitBranchArg },
    { name: 'log', description: '查看提交历史', options: [{ name: '--oneline' }, { name: '--graph' }, { name: '-p' }] },
    { name: 'status', description: '查看工作区状态', options: [{ name: '-s' }] },
    { name: 'clone', description: '克隆仓库', options: [{ name: '--depth', args: { name: 'depth' } }, { name: '--recursive' }] },
    { name: 'init', description: '初始化仓库', options: [{ name: '--bare' }] },
    {
      name: 'stash',
      description: '暂存工作区',
      subcommands: [
        { name: 'list', description: '列出暂存' },
        { name: 'pop', description: '恢复最近暂存' },
      ],
    },
    { name: 'fetch', description: '拉取远端对象', options: [{ name: '--all' }, { name: '--tags' }] },
    {
      name: 'remote',
      description: '管理远端',
      options: [{ name: '-v' }],
      subcommands: [
        { name: 'add', description: '添加远端' },
        { name: 'remove', description: '删除远端', args: gitRemoteArg },
        { name: 'rename', description: '重命名远端', args: gitRemoteArg },
        { name: 'set-url', description: '修改远端地址', args: gitRemoteArg },
      ],
    },
  ],
}

const dockerSpec: Spec = {
  name: 'docker',
  description: '容器引擎',
  options: [
    { name: '--help', description: '显示帮助' },
    { name: '--version', description: '显示版本' },
    { name: '-H', description: '指定 Docker daemon 地址', args: { name: 'host' } },
  ],
  subcommands: [
    {
      name: 'run',
      description: '创建并启动容器',
      options: [
        { name: '-d' },
        { name: '-it' },
        { name: '--name', args: { name: 'name' } },
        { name: '-p', args: { name: 'port' } },
        { name: '-v', args: { name: 'volume' } },
        { name: '-e', args: { name: 'env' } },
        { name: '--rm' },
        { name: '--network', args: { name: 'network' } },
      ],
    },
    { name: 'ps', description: '列出容器', options: [{ name: '-a' }, { name: '-q' }, { name: '--format', args: { name: 'format' } }] },
    { name: 'images', description: '列出镜像', options: [{ name: '-a' }, { name: '-q' }] },
    { name: 'logs', description: '查看容器日志', options: [{ name: '-f' }, { name: '--tail', args: { name: 'lines' } }, { name: '-t' }], args: dockerContainerArg(true) },
    { name: 'stop', description: '停止容器', args: dockerContainerArg(true) },
    { name: 'start', description: '启动容器', args: dockerContainerArg(true) },
    { name: 'restart', description: '重启容器', args: dockerContainerArg(true) },
    { name: 'rm', description: '删除容器', options: [{ name: '-f' }, { name: '-v' }], args: dockerContainerArg(true) },
    {
      name: 'exec',
      description: '在运行中的容器执行命令',
      options: [
        { name: '-it' },
        { name: '-u', args: { suggestions: [{ name: 'root' }, { name: 'www-data' }, { name: 'node' }] } },
        { name: '--privileged' },
      ],
      args: dockerContainerArg(),
    },
    { name: 'rmi', description: '删除镜像', options: [{ name: '-f' }] },
    { name: 'build', description: '构建镜像', options: [{ name: '-t', args: { name: 'tag' } }, { name: '-f', args: fileArg() }, { name: '--no-cache' }], args: fileArg(true) },
    { name: 'pull', description: '拉取镜像' },
    { name: 'push', description: '推送镜像' },
    { name: 'inspect', description: '查看详细信息', args: dockerContainerArg(true) },
    { name: 'stats', description: '资源使用统计', options: [{ name: '--no-stream' }], args: dockerContainerArg() },
    { name: 'compose', description: 'Docker Compose' },
    { name: 'login', description: '登录镜像仓库' },
    { name: 'logout', description: '退出镜像仓库' },
    { name: 'info', description: '显示系统信息' },
    { name: 'version', description: '显示版本' },
  ],
}

const kubectlSpec: Spec = {
  name: 'kubectl',
  description: 'Kubernetes CLI',
  options: [
    { name: '--help', description: '显示帮助' },
    { name: '-n', description: '指定命名空间', args: namespaceArg },
    { name: '--namespace', description: '指定命名空间', args: namespaceArg },
    { name: '--kubeconfig', description: '指定 kubeconfig 文件', args: fileArg() },
    { name: '-o', description: '输出格式', args: outputFormatArg },
    { name: '-v', description: '日志级别', args: { name: 'level' } },
  ],
  subcommands: [
    {
      name: 'get',
      description: '获取资源',
      options: [
        { name: '-n', args: namespaceArg },
        { name: '--namespace', args: namespaceArg },
        { name: '-o', args: outputFormatArg },
        { name: '-w' },
        { name: '--all-namespaces' },
      ],
      subcommands: k8sResourceTypes,
    },
    { name: 'describe', description: '查看资源详情', subcommands: k8sResourceTypes },
    { name: 'logs', description: '查看日志', options: [{ name: '-n', args: namespaceArg }, { name: '--namespace', args: namespaceArg }, { name: '-f' }, { name: '--tail', args: { name: 'lines' } }, { name: '-p' }, { name: '--previous' }], args: kubectlPodArg },
    { name: 'exec', description: '进入容器', options: [{ name: '-n', args: namespaceArg }, { name: '--namespace', args: namespaceArg }, { name: '-it' }, { name: '--' }], args: kubectlPodArg },
    { name: 'apply', description: '应用配置', options: [{ name: '-f', args: fileArg() }, { name: '-k', args: fileArg(true) }, { name: '--dry-run' }] },
    { name: 'delete', description: '删除资源', options: [{ name: '-f', args: fileArg() }, { name: '--grace-period', args: { name: 'seconds' } }], subcommands: k8sResourceTypes },
    { name: 'create', description: '创建资源' },
    { name: 'edit', description: '编辑资源', subcommands: k8sResourceTypes },
    { name: 'scale', description: '伸缩副本', subcommands: k8sResourceTypes },
    { name: 'port-forward', description: '端口转发', options: [{ name: '-n', args: namespaceArg }, { name: '--namespace', args: namespaceArg }], args: kubectlPodArg },
    {
      name: 'rollout',
      description: '滚动管理',
      subcommands: [
        { name: 'status', description: '查看状态', subcommands: k8sResourceTypes },
        { name: 'undo', description: '回滚', subcommands: k8sResourceTypes },
        { name: 'history', description: '查看历史', subcommands: k8sResourceTypes },
        { name: 'restart', description: '重启', subcommands: k8sResourceTypes },
      ],
    },
    {
      name: 'config',
      description: '配置管理',
      subcommands: [
        { name: 'view', description: '查看配置' },
        { name: 'use-context', description: '切换上下文', args: lineListArg('kubectl config get-contexts -o name', 10000) },
        { name: 'get-contexts', description: '列出上下文' },
        { name: 'current-context', description: '当前上下文' },
      ],
    },
    { name: 'cluster-info', description: '集群信息' },
    { name: 'top', description: '资源使用', subcommands: [{ name: 'nodes', description: '节点资源' }, { name: 'pods', description: 'Pod 资源' }] },
    { name: 'version', description: '版本信息' },
    { name: 'explain', description: '资源文档' },
    { name: 'cp', description: '复制文件' },
  ],
}

const npmSpec: Spec = {
  name: 'npm',
  description: 'Node 包管理',
  options: [{ name: '--help' }, { name: '--version' }],
  subcommands: [
    { name: 'install', description: '安装依赖', options: [{ name: '-g' }, { name: '--save-dev' }, { name: '-D' }, { name: '--save-prod' }, { name: '-P' }, { name: '--no-save' }, { name: '--force' }, { name: '--legacy-peer-deps' }] },
    { name: 'uninstall', description: '卸载包', options: [{ name: '-g' }, { name: '-D' }] },
    { name: 'update', description: '更新依赖' },
    { name: 'run', description: '运行脚本', args: npmScriptArg },
    { name: 'init', description: '初始化项目', options: [{ name: '-y' }] },
    { name: 'publish', description: '发布包' },
    { name: 'version', description: '版本管理' },
    { name: 'list', description: '列出已装包', options: [{ name: '-g' }, { name: '--depth', args: { suggestions: [{ name: '0' }, { name: '1' }, { name: '2' }] } }] },
    { name: 'audit', description: '安全审计', subcommands: [{ name: 'fix', description: '自动修复' }] },
    { name: 'login', description: '登录' },
    { name: 'logout', description: '退出' },
    { name: 'config', description: '配置管理', subcommands: [{ name: 'get' }, { name: 'set' }, { name: 'list' }, { name: 'delete' }] },
    { name: 'cache', description: '缓存管理', subcommands: [{ name: 'clean' }, { name: 'verify' }] },
    { name: 'start', description: '运行 start 脚本' },
    { name: 'test', description: '运行 test 脚本' },
    { name: 'ci', description: '基于 lockfile 安装' },
  ],
}

const systemctlSpec: Spec = {
  name: 'systemctl',
  description: 'systemd 服务管理',
  options: [{ name: '--help' }, { name: '--user' }, { name: '--now' }, { name: '--type', args: { name: 'type' } }, { name: '-t', args: { name: 'type' } }, { name: '--all' }, { name: '--no-pager' }],
  subcommands: [
    { name: 'start', description: '启动服务', args: systemdServiceUnitsArg },
    { name: 'stop', description: '停止服务', args: systemdServiceUnitsArg },
    { name: 'restart', description: '重启服务', args: systemdServiceUnitsArg },
    { name: 'reload', description: '重载配置', args: systemdServiceUnitsArg },
    { name: 'status', description: '查看状态', args: systemdActiveUnitsArg },
    { name: 'enable', description: '开机启用', options: [{ name: '--now' }], args: systemdServiceUnitsArg },
    { name: 'disable', description: '禁用开机启动', args: systemdServiceUnitsArg },
    { name: 'is-active', description: '是否运行中', args: systemdActiveUnitsArg },
    { name: 'is-enabled', description: '是否开机启用', args: systemdServiceUnitsArg },
    { name: 'is-failed', description: '是否失败', args: systemdFailedUnitsArg },
    { name: 'list-units', description: '列出单元', options: [{ name: '--type', args: { name: 'type' } }, { name: '--state', args: { name: 'state' } }, { name: '--all' }] },
    { name: 'list-unit-files', description: '列出单元文件' },
    { name: 'daemon-reload', description: '重载 systemd 配置' },
    { name: 'daemon-reexec', description: '重新执行 systemd' },
    { name: 'edit', description: '编辑单元覆盖', options: [{ name: '--full' }], args: systemdServiceUnitsArg },
    { name: 'cat', description: '查看单元文件', args: systemdServiceUnitsArg },
    { name: 'show', description: '显示单元属性', args: systemdServiceUnitsArg },
    { name: 'mask', description: '屏蔽服务', args: systemdServiceUnitsArg },
    { name: 'unmask', description: '取消屏蔽', args: systemdServiceUnitsArg },
    { name: 'reset-failed', description: '重置失败状态' },
  ],
}

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
  { name: 'vi', description: '编辑器' },
  { name: 'nano', description: '编辑器' },
  { name: 'less', description: '分页查看' },
  { name: 'tail', description: '查看文件末尾' },
  { name: 'head', description: '查看文件开头' },
  { name: 'cp', description: '复制文件' },
  { name: 'mv', description: '移动文件' },
  { name: 'rm', description: '删除文件' },
  { name: 'touch', description: '创建空文件' },
  { name: 'mkdir', description: '创建目录' },
  { name: 'chmod', description: '修改权限' },
  { name: 'chown', description: '修改属主' },
  { name: 'tar', description: '归档' },
  { name: 'source', description: '执行脚本' },
  { name: 'bash', description: '执行脚本' },
]

function makeFileCommandSpec(name: string, description: string, dirsOnly = false): Spec {
  return {
    name,
    description,
    args: fileArg(dirsOnly),
  }
}

const fileCommandSpecs: Record<string, Spec> = {
  cd: makeFileCommandSpec('cd', '切换目录', true),
  ls: makeFileCommandSpec('ls', '列出目录'),
  cat: makeFileCommandSpec('cat', '查看文件'),
  less: makeFileCommandSpec('less', '分页查看'),
  more: makeFileCommandSpec('more', '分页查看'),
  head: makeFileCommandSpec('head', '查看文件开头'),
  tail: makeFileCommandSpec('tail', '查看文件末尾'),
  vi: makeFileCommandSpec('vi', '编辑器'),
  vim: makeFileCommandSpec('vim', '编辑器'),
  nano: makeFileCommandSpec('nano', '编辑器'),
  rm: makeFileCommandSpec('rm', '删除文件'),
  cp: makeFileCommandSpec('cp', '复制文件'),
  mv: makeFileCommandSpec('mv', '移动文件'),
  touch: makeFileCommandSpec('touch', '创建空文件'),
  chmod: makeFileCommandSpec('chmod', '修改权限'),
  chown: makeFileCommandSpec('chown', '修改属主'),
  find: makeFileCommandSpec('find', '查找文件', true),
  grep: makeFileCommandSpec('grep', '文本搜索'),
  mkdir: makeFileCommandSpec('mkdir', '创建目录', true),
  rmdir: makeFileCommandSpec('rmdir', '删除目录', true),
  tar: makeFileCommandSpec('tar', '归档'),
  unzip: makeFileCommandSpec('unzip', '解压 zip'),
  source: makeFileCommandSpec('source', '执行脚本'),
  bash: makeFileCommandSpec('bash', '执行脚本'),
  sh: makeFileCommandSpec('sh', '执行脚本'),
}

const specMap: Record<string, Spec> = {
  git: gitSpec,
  docker: dockerSpec,
  kubectl: kubectlSpec,
  npm: npmSpec,
  systemctl: systemctlSpec,
  ...fileCommandSpecs,
}

export function getSpec(command: string): Spec | undefined {
  return specMap[command]
}

export function getCommandIndex() {
  return commandIndex
}
