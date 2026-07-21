import { describe, expect, it } from 'vitest'

import {
  buildCompletionInsertText,
  buildCompletionInsertPlan,
  getDynamicGenerator,
  getSuggestions,
  isCdPathContext,
  parseDirectoryListOutput,
  parseLineListOutput,
  tokenize,
  type CompletionContext,
} from './completionEngine'

function ctx(input: string): CompletionContext {
  return tokenize(input)
}

describe('completionEngine', () => {
  it('keeps quoted shell tokens intact while tokenizing', () => {
    expect(tokenize(`kubectl -n "kube system" lo`)).toEqual({
      tokens: ['kubectl', '-n', '"kube system"'],
      currentToken: 'lo',
      cursorTokenIndex: 3,
    })
  })

  it('treats option arguments as consumed before resolving subcommands', () => {
    const suggestions = getSuggestions(ctx('kubectl -n kube-system lo')).suggestions.map((item) => item.name)
    expect(suggestions).toContain('logs')
  })

  it('escapes spaces for unquoted file path completions', () => {
    expect(buildCompletionInsertText('My', 'My File.txt')).toBe('\\ File.txt')
  })

  it('preserves ongoing double-quoted completion context', () => {
    expect(buildCompletionInsertText('"My', 'My File.txt')).toBe(' File.txt')
  })

  it('escapes embedded single quotes when already inside single quotes', () => {
    expect(buildCompletionInsertText(`'O`, `O'Reilly.txt`)).toBe(`'\\''Reilly.txt`)
  })

  it('avoids auto-separator when the current token is still quoted', () => {
    expect(buildCompletionInsertPlan('"My', 'My File.txt')).toEqual({
      insertText: ' File.txt',
      canAppendSeparator: false,
    })
  })

  it('allows auto-separator after unquoted completions', () => {
    expect(buildCompletionInsertPlan('fea', 'feature/demo')).toEqual({
      insertText: 'ture/demo',
      canAppendSeparator: true,
    })
  })

  it('supports completing option values attached with equals for static args', () => {
    expect(getSuggestions(ctx('kubectl get pods -o=js')).suggestions).toContainEqual(
      expect.objectContaining({ name: 'json', type: 'arg', origin: 'static' })
    )
  })

  it('resolves dynamic generators for option values attached with equals', () => {
    expect(getDynamicGenerator(ctx('kubectl --namespace=ku'))).toMatchObject({
      parser: 'kubectl-name',
      script: 'kubectl get namespaces -o name',
    })
  })

  it('renders namespace-aware dynamic scripts when namespace uses equals syntax', () => {
    expect(getDynamicGenerator(ctx('kubectl get pods --namespace=kube-system po'))).toMatchObject({
      parser: 'kubectl-name',
      script: 'kubectl get pods -o name -n kube-system',
    })
  })

  it('only inserts the suffix of an equals-attached file path completion', () => {
    expect(buildCompletionInsertPlan('--kubeconfig=./My', './My File')).toEqual({
      insertText: '\\ File',
      canAppendSeparator: true,
    })
  })

  it('builds dynamic generator for npm run scripts', () => {
    expect(getDynamicGenerator(ctx('npm run de'))).toMatchObject({
      parser: 'line-list',
      cacheTtl: 10000,
    })
  })

  it('parses generic line-list output as dynamic arg suggestions', () => {
    expect(parseLineListOutput('alpha\nbeta\n', 'be')).toEqual([
      { name: 'beta', type: 'arg', origin: 'dynamic' },
    ])
  })

  it('detects cd path context for cascading directory menus', () => {
    expect(isCdPathContext(ctx('cd '))).toBe(true)
    expect(isCdPathContext(ctx('cd /Pro'))).toBe(true)
    expect(isCdPathContext(ctx('cd Projects/lan'))).toBe(true)
    expect(isCdPathContext(ctx('ls /Pro'))).toBe(false)
    expect(isCdPathContext(ctx('git ch'))).toBe(false)
  })

  it('uses directory-list parser for cd file generator', () => {
    expect(getDynamicGenerator(ctx('cd /Pro'))).toMatchObject({ parser: 'directory-list' })
    // 非 cd 的文件命令保持 file-list
    expect(getDynamicGenerator(ctx('cat /Pro'))).toMatchObject({ parser: 'file-list' })
  })

  it('parses directory-list output keeping dirs and files with short displayName', () => {
    const out = 'proc/\nProjects/\nfile.txt\nREADME.md\n'
    const result = parseDirectoryListOutput(out, '/')
    // 目录+文件都保留；name 存完整路径，displayName 存短名
    expect(result).toEqual([
      { name: '/proc/', displayName: 'proc/', type: 'directory', isDir: true, origin: 'dynamic' },
      { name: '/Projects/', displayName: 'Projects/', type: 'directory', isDir: true, origin: 'dynamic' },
      { name: '/file.txt', displayName: 'file.txt', type: 'directory', isDir: false, origin: 'dynamic' },
      { name: '/README.md', displayName: 'README.md', type: 'directory', isDir: false, origin: 'dynamic' },
    ])
  })

  it('parses subdirectory output relative to an expanded path prefix', () => {
    const out = 'yuweinfo/\nlanya/\nindex.ts\n'
    const result = parseDirectoryListOutput(out, '/Projects/')
    // name 是完整路径（用于应用/展开），displayName 只含当前段（末级不显示全路径）
    expect(result).toEqual([
      { name: '/Projects/yuweinfo/', displayName: 'yuweinfo/', type: 'directory', isDir: true, origin: 'dynamic' },
      { name: '/Projects/lanya/', displayName: 'lanya/', type: 'directory', isDir: true, origin: 'dynamic' },
      { name: '/Projects/index.ts', displayName: 'index.ts', type: 'directory', isDir: false, origin: 'dynamic' },
    ])
  })

  it('filters directory-list output by the current base prefix', () => {
    const out = 'proc/\nProjects/\n'
    const result = parseDirectoryListOutput(out, '/Pro')
    expect(result).toEqual([
      { name: '/Projects/', displayName: 'Projects/', type: 'directory', isDir: true, origin: 'dynamic' },
    ])
  })

  it('strips executable/symlink markers from ls -F output', () => {
    const out = 'run.sh*\nlink@\nreal/\n'
    const result = parseDirectoryListOutput(out, '/')
    expect(result).toEqual([
      { name: '/run.sh', displayName: 'run.sh', type: 'directory', isDir: false, origin: 'dynamic' },
      { name: '/link', displayName: 'link', type: 'directory', isDir: false, origin: 'dynamic' },
      { name: '/real/', displayName: 'real/', type: 'directory', isDir: true, origin: 'dynamic' },
    ])
  })
})
