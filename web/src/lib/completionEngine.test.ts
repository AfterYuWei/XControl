import { describe, expect, it } from 'vitest'

import {
  buildCompletionInsertText,
  buildCompletionInsertPlan,
  getDynamicGenerator,
  getSuggestions,
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
})
