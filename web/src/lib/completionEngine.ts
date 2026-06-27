// 补全引擎:分词 + Spec 树遍历 + 前缀匹配 + 动态 generator
// POC 假设:光标在行尾(fresh 输入)

import { getSpec, getCommandIndex, type Suggestion, type Spec, type Subcommand } from './completionSpecs'

// 透传 Suggestion 类型,供 useCompletion 等下游模块统一从本模块导入
export type { Suggestion } from './completionSpecs'

export interface CompletionContext {
  tokens: string[]          // 已完成的 token(不含当前正在键入的)
  currentToken: string      // 光标所在正在键入的 token(可能为空)
  cursorTokenIndex: number  // 当前 token 的索引(0 = 命令名位置)
}

export interface CompletionResult {
  suggestions: Suggestion[]
}

export type ParserKey = 'git-branch' | 'docker-ps' | 'kubectl-name'

export interface DynamicGenerator {
  script: string
  cacheTtl: number
  parser: ParserKey
}

// 分词:按空格分割。POC 仅处理光标在行尾的情况
export function tokenize(inputText: string): CompletionContext {
  const endsWithSpace = inputText.length > 0 && /\s$/.test(inputText)
  const trimmed = inputText.trim()
  if (trimmed === '') {
    return { tokens: [], currentToken: '', cursorTokenIndex: 0 }
  }
  const parts = trimmed.split(/\s+/)
  if (endsWithSpace) {
    return { tokens: parts, currentToken: '', cursorTokenIndex: parts.length }
  }
  const currentToken = parts[parts.length - 1]
  const tokens = parts.slice(0, -1)
  return { tokens, currentToken, cursorTokenIndex: tokens.length }
}

export function getSuggestions(ctx: CompletionContext): CompletionResult {
  const { tokens, currentToken, cursorTokenIndex } = ctx

  // 第一个 token:命令名补全
  if (cursorTokenIndex === 0) {
    const idx = getCommandIndex()
    const suggestions: Suggestion[] = idx
      .filter((c) => c.name.startsWith(currentToken))
      .map((c) => ({ name: c.name, description: c.description, type: 'command' as const }))
    return { suggestions }
  }

  const command = tokens[0]
  const spec = getSpec(command)
  if (!spec) return { suggestions: [] }

  // 沿已键入的子命令路径定位当前层级
  let level: Spec | Subcommand = spec
  for (let i = 1; i < cursorTokenIndex; i++) {
    const tok = tokens[i]
    if (tok.startsWith('-')) continue // 选项不改变层级
    const sub = level.subcommands?.find((s) => s.name === tok)
    if (sub) {
      level = sub
    } else {
      return { suggestions: [] }
    }
  }

  const suggestions: Suggestion[] = []
  if (currentToken.startsWith('-')) {
    // 选项补全
    for (const opt of level.options ?? []) {
      if (opt.name.startsWith(currentToken)) {
        suggestions.push({ name: opt.name, description: opt.description, type: 'option' })
      }
    }
  } else {
    // 子命令补全
    for (const sub of level.subcommands ?? []) {
      if (sub.name.startsWith(currentToken)) {
        suggestions.push({ name: sub.name, description: sub.description, type: 'subcommand' })
      }
    }
    // 同时附上选项(前缀匹配)
    for (const opt of level.options ?? []) {
      if (opt.name.startsWith(currentToken)) {
        suggestions.push({ name: opt.name, description: opt.description, type: 'option' })
      }
    }
  }

  return { suggestions }
}

// 从 kubectl 命令 tokens 中解析 -n/--namespace 的值,无则返回 default
function getKubectlNamespace(tokens: string[]): string {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-n' || tokens[i] === '--namespace') {
      if (i + 1 < tokens.length) return tokens[i + 1]
    }
  }
  return 'default'
}

// 替换 generator script 中的占位符:{{namespace}}/{{cwd}}
function renderScript(script: string, ctx: CompletionContext, cwd?: string): string {
  return script
    .replace(/\{\{namespace\}\}/g, getKubectlNamespace(ctx.tokens))
    .replace(/\{\{cwd\}\}/g, cwd ?? '')
}

// 定位当前位置的动态 generator(若有)
// 规则:沿 tokens 路径定位层级,若 currentToken 不以 "-" 开头且 level.args.generator 存在,返回 generator
export function getDynamicGenerator(ctx: CompletionContext, cwd?: string): DynamicGenerator | null {
  const { tokens, currentToken, cursorTokenIndex } = ctx
  if (cursorTokenIndex === 0) return null // 命令名位置不做动态
  if (currentToken.startsWith('-')) return null // 选项位置不做动态

  const command = tokens[0]
  const spec = getSpec(command)
  if (!spec) return null

  // 沿已键入的子命令路径定位当前层级
  let level: Spec | Subcommand = spec
  for (let i = 1; i < cursorTokenIndex; i++) {
    const tok = tokens[i]
    if (tok.startsWith('-')) continue // 选项不改变层级
    const sub = level.subcommands?.find((s) => s.name === tok)
    if (sub) {
      level = sub
    } else {
      return null
    }
  }

  const gen = level.args?.generator
  if (!gen) return null
  return {
    script: renderScript(gen.script, ctx, cwd),
    cacheTtl: gen.cacheTtl ?? 10000,
    parser: gen.parser ?? 'git-branch',
  }
}

// 根据 generator.parser 把脚本输出解析成候选
const parsers: Record<ParserKey, (output: string, currentToken: string) => Suggestion[]> = {
  'git-branch': parseDynamicOutput,
  'docker-ps': parseDockerContainerOutput,
  'kubectl-name': parseKubectlNameOutput,
}

export function parseDynamicOutputByParser(output: string, currentToken: string, parser: ParserKey): Suggestion[] {
  const fn = parsers[parser] ?? parseDynamicOutput
  return fn(output, currentToken)
}

// 把脚本 stdout 解析成 Suggestion[]
// 处理 git branch --list 的输出格式(* main / develop / feature/x)
export function parseDynamicOutput(output: string, currentToken: string): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  for (const rawLine of output.split('\n')) {
    // 去掉前后空白,去掉 git branch 的当前分支 * 标记
    const name = rawLine.trim().replace(/^\*\s*/, '')
    if (!name) continue
    if (!name.startsWith(currentToken)) continue
    if (seen.has(name)) continue
    seen.add(name)
    result.push({ name, type: 'arg' })
  }
  return result
}

// 把脚本 stdout 按行切分为原始字符串(用于缓存写入)
export function splitOutputLines(output: string): string[] {
  return output
    .split('\n')
    .map((s) => s.trim().replace(/^\*\s*/, ''))
    .filter((s) => s.length > 0)
}

// 解析 docker ps --format 'ID\tNames' 输出,同时生成 ID 和名称候选
export function parseDockerContainerOutput(output: string, currentToken: string): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const id = parts[0] ?? ''
    const name = parts[parts.length - 1] ?? ''
    if (!id || !name) continue
    for (const value of [id, name]) {
      if (!value.startsWith(currentToken)) continue
      if (seen.has(value)) continue
      seen.add(value)
      result.push({ name: value, type: 'arg' })
    }
  }
  return result
}

// 解析 kubectl get -o name 输出(pod/nginx-xxx),去掉资源前缀
export function parseKubectlNameOutput(output: string, currentToken: string): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  for (const rawLine of output.split('\n')) {
    let name = rawLine.trim()
    if (!name) continue
    const slashIdx = name.indexOf('/')
    if (slashIdx !== -1) name = name.slice(slashIdx + 1)
    if (!name.startsWith(currentToken)) continue
    if (seen.has(name)) continue
    seen.add(name)
    result.push({ name, type: 'arg' })
  }
  return result
}
