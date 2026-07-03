// Completion engine: tokenization, spec traversal, static matching and
// dynamic generator resolution.

import {
  getSpec,
  getCommandIndex,
  type Arg,
  type Option,
  type Suggestion,
  type Spec,
  type Subcommand,
} from './completionSpecs'

export type { Suggestion } from './completionSpecs'

export interface CompletionContext {
  tokens: string[]
  currentToken: string
  cursorTokenIndex: number
}

export interface CompletionResult {
  suggestions: Suggestion[]
}

export type ParserKey = 'git-branch' | 'docker-ps' | 'kubectl-name' | 'file-list' | 'line-list'

export interface DynamicGenerator {
  script: string
  cacheTtl: number
  parser: ParserKey
  dirsOnly?: boolean
}

export interface CompletionInsertPlan {
  insertText: string
  canAppendSeparator: boolean
}

interface ResolutionState {
  path: Array<Spec | Subcommand>
  level: Spec | Subcommand
  argSource?: Arg
}

interface TokenParseState {
  value: string
  quote: '"' | "'" | null
}

interface MatchedOptionToken {
  option: Option
  value: string | null
  usesEquals: boolean
}

export function tokenize(inputText: string): CompletionContext {
  const parts = splitShellTokens(inputText)
  if (parts.length === 0) {
    return { tokens: [], currentToken: '', cursorTokenIndex: 0 }
  }

  if (endsWithTokenSeparator(inputText)) {
    return { tokens: parts, currentToken: '', cursorTokenIndex: parts.length }
  }

  return {
    tokens: parts.slice(0, -1),
    currentToken: parts[parts.length - 1] ?? '',
    cursorTokenIndex: parts.length - 1,
  }
}

export function buildCompletionInsertText(currentTokenRaw: string, suggestionName: string): string {
  return buildCompletionInsertPlan(currentTokenRaw, suggestionName).insertText
}

export function buildCompletionInsertPlan(currentTokenRaw: string, suggestionName: string): CompletionInsertPlan {
  const state = parseTokenState(extractCurrentTokenRawValue(currentTokenRaw))
  if (!suggestionName.startsWith(state.value)) {
    return {
      insertText: encodeCompletionText(suggestionName, state.quote),
      canAppendSeparator: state.quote === null,
    }
  }

  const suffix = suggestionName.slice(state.value.length)
  return {
    insertText: encodeCompletionText(suffix, state.quote),
    canAppendSeparator: state.quote === null,
  }
}

export function getSuggestions(ctx: CompletionContext): CompletionResult {
  const currentValue = getCurrentCompletionValue(ctx.currentToken)
  if (ctx.cursorTokenIndex === 0) {
    const suggestions = getCommandIndex()
      .filter((entry) => entry.name.startsWith(currentValue))
      .map((entry) => ({ name: entry.name, description: entry.description, type: 'command' as const, origin: 'static' as const }))
    return { suggestions }
  }

  const state = resolveState(ctx)
  if (!state) return { suggestions: [] }

  const currentArgSource = state.argSource ?? resolveCurrentTokenArgSource(state.path, ctx.currentToken)
  if (currentArgSource) {
    return { suggestions: getArgSuggestions(currentArgSource, currentValue) }
  }

  const suggestions: Suggestion[] = []
  if (currentValue.startsWith('-')) {
    appendOptionSuggestions(suggestions, getAvailableOptions(state.path), currentValue)
    return { suggestions: dedupeSuggestions(suggestions) }
  }

  appendSubcommandSuggestions(suggestions, state.level.subcommands, currentValue)
  appendOptionSuggestions(suggestions, getAvailableOptions(state.path), currentValue)
  suggestions.push(...getArgSuggestions(state.level.args, currentValue))
  return { suggestions: dedupeSuggestions(suggestions) }
}

function getKubectlNamespace(tokens: string[]): string {
  for (let i = 0; i < tokens.length; i++) {
    const token = decodeToken(tokens[i] ?? '')
    if (token === '-n' || token === '--namespace') {
      if (i + 1 < tokens.length) return decodeToken(tokens[i + 1] ?? '')
    }
    if (token.startsWith('--namespace=')) {
      return token.slice('--namespace='.length)
    }
  }
  return 'default'
}

function renderScript(script: string, ctx: CompletionContext, cwd?: string): string {
  return script
    .replace(/\{\{namespace\}\}/g, getKubectlNamespace(ctx.tokens))
    .replace(/\{\{cwd\}\}/g, cwd ?? '')
}

function buildFileListScript(currentToken: string): string {
  const lastSlash = currentToken.lastIndexOf('/')
  const dir = lastSlash >= 0 ? currentToken.slice(0, lastSlash + 1) : '.'
  const escapedDir = dir.replace(/'/g, "'\\''")
  return `ls -1 -A -F '${escapedDir}' 2>/dev/null`
}

export function getDynamicGenerator(ctx: CompletionContext, cwd?: string): DynamicGenerator | null {
  if (ctx.cursorTokenIndex === 0) return null

  const state = resolveState(ctx)
  if (!state) return null

  const currentValue = getCurrentCompletionValue(ctx.currentToken)
  const currentArgSource = state.argSource ?? resolveCurrentTokenArgSource(state.path, ctx.currentToken)
  if (!currentArgSource && currentValue.startsWith('-')) return null

  const arg = currentArgSource ?? state.level.args
  if (!arg) return null

  if (arg.fileGenerator) {
    return {
      script: buildFileListScript(extractCurrentTokenRawValue(ctx.currentToken)),
      cacheTtl: arg.fileGenerator.cacheTtl ?? 3000,
      parser: 'file-list',
      dirsOnly: arg.fileGenerator.dirsOnly ?? false,
    }
  }

  if (!arg.generator) return null
  return {
    script: renderScript(arg.generator.script, ctx, cwd),
    cacheTtl: arg.generator.cacheTtl ?? 10000,
    parser: arg.generator.parser ?? 'git-branch',
  }
}

const parsers: Record<ParserKey, (output: string, currentToken: string, dirsOnly?: boolean) => Suggestion[]> = {
  'git-branch': parseDynamicOutput,
  'docker-ps': parseDockerContainerOutput,
  'kubectl-name': parseKubectlNameOutput,
  'file-list': parseFileListOutput,
  'line-list': parseLineListOutput,
}

export function parseDynamicOutputByParser(
  output: string,
  currentToken: string,
  parser: ParserKey,
  dirsOnly?: boolean
): Suggestion[] {
  const fn = parsers[parser] ?? parseDynamicOutput
  const prefix = parser === 'file-list'
    ? extractCurrentTokenRawValue(currentToken)
    : getCurrentCompletionValue(currentToken)
  return fn(output, prefix, dirsOnly)
}

export function parseDynamicOutput(output: string, currentToken: string): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  for (const rawLine of output.split('\n')) {
    const name = rawLine.trim().replace(/^\*\s*/, '')
    if (!name || !name.startsWith(currentToken) || seen.has(name)) continue
    seen.add(name)
    result.push({ name, type: 'arg', origin: 'dynamic' })
  }
  return result
}

export function splitOutputLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter((line) => line.length > 0)
}

export function parseDockerContainerOutput(output: string, currentToken: string): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const id = parts[0] ?? ''
    const name = parts[parts.length - 1] ?? ''
    if (!id || !name || !name.startsWith(currentToken) || seen.has(name)) continue
    seen.add(name)
    result.push({ name, type: 'arg', description: id, origin: 'dynamic' })
  }
  return result
}

export function parseKubectlNameOutput(output: string, currentToken: string): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  for (const rawLine of output.split('\n')) {
    const rawName = rawLine.trim()
    if (!rawName) continue
    const slashIdx = rawName.indexOf('/')
    const name = slashIdx === -1 ? rawName : rawName.slice(slashIdx + 1)
    if (!name.startsWith(currentToken) || seen.has(name)) continue
    seen.add(name)
    const kind = slashIdx === -1 ? '' : rawName.slice(0, slashIdx)
    result.push({ name, type: 'arg', description: kind || undefined, origin: 'dynamic' })
  }
  return result
}

export function parseLineListOutput(output: string, currentToken: string): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  for (const rawLine of output.split('\n')) {
    const name = rawLine.trim()
    if (!name || !name.startsWith(currentToken) || seen.has(name)) continue
    seen.add(name)
    result.push({ name, type: 'arg', origin: 'dynamic' })
  }
  return result
}

export function parseFileListOutput(output: string, currentToken: string, dirsOnly?: boolean): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  const lastSlash = currentToken.lastIndexOf('/')
  const dirPrefix = lastSlash >= 0 ? currentToken.slice(0, lastSlash + 1) : ''
  const base = lastSlash >= 0 ? currentToken.slice(lastSlash + 1) : currentToken

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const lastChar = line[line.length - 1]
    let fileName = line
    let isDir = false
    if (lastChar === '/') {
      isDir = true
    } else if (lastChar === '*' || lastChar === '@' || lastChar === '|' || lastChar === '=') {
      fileName = line.slice(0, -1)
    }

    if (!fileName.startsWith(base) || (dirsOnly && !isDir)) continue
    const fullName = dirPrefix + fileName
    if (seen.has(fullName)) continue
    seen.add(fullName)
    result.push({ name: fullName, type: 'arg', description: isDir ? '目录' : undefined, origin: 'dynamic' })
  }
  return result
}

function splitShellTokens(inputText: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escape = false

  for (const ch of inputText) {
    if (!quote && !escape && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += ch
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escape = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    }
  }

  if (current.length > 0) tokens.push(current)
  return tokens
}

function endsWithTokenSeparator(inputText: string): boolean {
  let quote: '"' | "'" | null = null
  let escape = false

  for (const ch of inputText) {
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escape = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    }
  }

  return !quote && !escape && inputText.length > 0 && /\s$/.test(inputText)
}

function decodeToken(token: string): string {
  return parseTokenState(token).value
}

function resolveState(ctx: CompletionContext): ResolutionState | null {
  const command = decodeToken(ctx.tokens[0] ?? '')
  const spec = getSpec(command)
  if (!spec) return null

  let level: Spec | Subcommand = spec
  const path: Array<Spec | Subcommand> = [spec]
  let pendingArg: Arg | undefined

  for (let i = 1; i < ctx.cursorTokenIndex; i++) {
    const token = decodeToken(ctx.tokens[i] ?? '')
    if (pendingArg) {
      pendingArg = undefined
      continue
    }

    const optionMatch = matchOptionToken(path, token)
    if (optionMatch) {
      if (!optionMatch.usesEquals) {
        pendingArg = optionMatch.option.args
      }
      continue
    }

    if (token.startsWith('-')) {
      continue
    }

    const subcommand = level.subcommands?.find((entry) => entry.name === token)
    if (subcommand) {
      level = subcommand
      path.push(subcommand)
      continue
    }

    if (level.args) {
      continue
    }

    return null
  }

  return { path, level, argSource: pendingArg }
}

function findOption(path: Array<Spec | Subcommand>, token: string): Option | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const option = path[i]?.options?.find((entry) => entry.name === token)
    if (option) return option
  }
  return undefined
}

function matchOptionToken(path: Array<Spec | Subcommand>, token: string): MatchedOptionToken | undefined {
  const exact = findOption(path, token)
  if (exact) {
    return { option: exact, value: null, usesEquals: false }
  }

  const equalsIndex = token.indexOf('=')
  if (equalsIndex <= 0) return undefined

  const optionName = token.slice(0, equalsIndex)
  const option = findOption(path, optionName)
  if (!option?.args) return undefined

  return {
    option,
    value: token.slice(equalsIndex + 1),
    usesEquals: true,
  }
}

function resolveCurrentTokenArgSource(path: Array<Spec | Subcommand>, currentTokenRaw: string): Arg | undefined {
  const token = decodeToken(currentTokenRaw)
  const optionMatch = matchOptionToken(path, token)
  if (!optionMatch?.usesEquals) return undefined
  return optionMatch.option.args
}

function getAvailableOptions(path: Array<Spec | Subcommand>): Option[] {
  const result: Option[] = []
  const seen = new Set<string>()

  for (let i = path.length - 1; i >= 0; i--) {
    for (const option of path[i]?.options ?? []) {
      if (seen.has(option.name)) continue
      seen.add(option.name)
      result.push(option)
    }
  }

  return result
}

function getArgSuggestions(arg: Arg | undefined, currentToken: string): Suggestion[] {
  if (!arg?.suggestions?.length) return []
  return arg.suggestions
    .filter((entry) => entry.name.startsWith(currentToken))
    .map((entry) => ({ name: entry.name, description: entry.description, type: 'arg' as const, origin: 'static' as const }))
}

function appendOptionSuggestions(target: Suggestion[], options: Option[] | undefined, currentToken: string) {
  for (const option of options ?? []) {
    if (option.name.startsWith(currentToken)) {
      target.push({ name: option.name, description: option.description, type: 'option', origin: 'static' })
    }
  }
}

function appendSubcommandSuggestions(target: Suggestion[], subcommands: Subcommand[] | undefined, currentToken: string) {
  for (const subcommand of subcommands ?? []) {
    if (subcommand.name.startsWith(currentToken)) {
      target.push({ name: subcommand.name, description: subcommand.description, type: 'subcommand', origin: 'static' })
    }
  }
}

function dedupeSuggestions(suggestions: Suggestion[]): Suggestion[] {
  const seen = new Set<string>()
  const result: Suggestion[] = []
  for (const suggestion of suggestions) {
    const key = `${suggestion.type}\0${suggestion.name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(suggestion)
  }
  return result
}

function parseTokenState(token: string): TokenParseState {
  let value = ''
  let quote: '"' | "'" | null = null
  let escape = false

  for (const ch of token) {
    if (escape) {
      value += ch
      escape = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escape = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        value += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    value += ch
  }

  if (escape) value += '\\'
  return { value, quote }
}

function extractCurrentTokenRawValue(currentTokenRaw: string): string {
  if (!currentTokenRaw.startsWith('-')) return currentTokenRaw
  const equalsIndex = currentTokenRaw.indexOf('=')
  if (equalsIndex === -1) return currentTokenRaw
  return currentTokenRaw.slice(equalsIndex + 1)
}

function getCurrentCompletionValue(currentTokenRaw: string): string {
  return decodeToken(extractCurrentTokenRawValue(currentTokenRaw))
}

function encodeCompletionText(text: string, quote: '"' | "'" | null): string {
  if (quote === "'") {
    return text.replace(/'/g, `'\\''`)
  }
  if (quote === '"') {
    return text.replace(/["\\$`]/g, '\\$&')
  }
  return text.replace(/([^A-Za-z0-9_./-])/g, '\\$1')
}
