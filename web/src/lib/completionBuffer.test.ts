import { describe, expect, it } from 'vitest'

import { extractInputFromLine, isTuiCommand } from './completionBuffer'

describe('completionBuffer', () => {
  it('detects tui commands behind shell prefixes', () => {
    expect(isTuiCommand('sudo vim /etc/hosts')).toBe(true)
    expect(isTuiCommand('command less README.md')).toBe(true)
    expect(isTuiCommand('sudo echo hello')).toBe(false)
  })

  it('strips prompt text from complex shell lines', () => {
    expect(extractInputFromLine('[12:34:56] user@host:/srv/app$ git status')).toMatchObject({
      text: 'git status',
    })
  })

  it('falls back to raw input when no prompt delimiter is found', () => {
    expect(extractInputFromLine('plain command without prompt')).toEqual({
      text: 'plain command without prompt',
      promptEnd: 0,
    })
  })
})
