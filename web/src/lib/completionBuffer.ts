import type { Terminal } from '@xterm/xterm'

export interface BufferState {
  text: string
  cursor: number
  stale: boolean
}

const TUI_START_COMMANDS = new Set([
  'vim', 'vi', 'nvim', 'nano', 'emacs',
  'htop', 'top', 'btop', 'gtop',
  'less', 'more', 'most',
  'tmux', 'screen',
  'fzf',
])

const SHELL_PREFIX_COMMANDS = new Set(['sudo', 'doas', 'env', 'command'])

export function isTuiCommand(input: string): boolean {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false

  const first = normalizeCommandToken(tokens[0] ?? '')
  if (TUI_START_COMMANDS.has(first)) return true

  if (SHELL_PREFIX_COMMANDS.has(first) && tokens.length > 1) {
    const second = normalizeCommandToken(tokens[1] ?? '')
    return TUI_START_COMMANDS.has(second)
  }

  return false
}

export function detectTuiSequence(data: string): 'enter' | 'exit' | null {
  if (data.includes('\x1b[?1049h') || data.includes('\x1b[?1047h')) return 'enter'
  if (data.includes('\x1b[?1049l') || data.includes('\x1b[?1047l')) return 'exit'
  return null
}

export function extractInputFromLine(rawLine: string): { text: string; promptEnd: number } {
  if (!rawLine) return { text: '', promptEnd: -1 }

  const promptEnd = findPromptEnd(rawLine)
  if (promptEnd === -1) {
    return { text: rawLine.trimStart(), promptEnd: 0 }
  }

  return {
    text: rawLine.slice(promptEnd).trimStart(),
    promptEnd,
  }
}

export function resyncFromTerminal(getTerminal: () => Terminal | null): BufferState {
  const terminal = getTerminal()
  if (!terminal) {
    return { text: '', cursor: 0, stale: false }
  }

  const rawLine = readLogicalLine(terminal)
  const { text } = extractInputFromLine(rawLine)
  return { text, cursor: text.length, stale: false }
}

export function moveCursorInBuffer(state: BufferState, delta: number): boolean {
  if (state.stale) return false
  const next = state.cursor + delta
  if (next < 0 || next > state.text.length) return false
  state.cursor = next
  return true
}

function normalizeCommandToken(token: string): string {
  return token.replace(/.*\//, '')
}

function readLogicalLine(terminal: Terminal): string {
  const active = terminal.buffer.active
  let start = active.cursorY
  let end = active.cursorY

  while (start > 0) {
    const line = active.getLine(start)
    if (!line?.isWrapped) break
    start -= 1
  }

  while (true) {
    const next = active.getLine(end + 1)
    if (!next?.isWrapped) break
    end += 1
  }

  let text = ''
  for (let row = start; row <= end; row++) {
    const line = active.getLine(row)
    if (!line) continue
    text += line.translateToString(true)
  }
  return text
}

function findPromptEnd(rawLine: string): number {
  const candidates: number[] = []

  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i]
    if (ch !== '$' && ch !== '#' && ch !== '%' && ch !== '>') continue

    const after = rawLine[i + 1]
    if (after === undefined || after === ' ') {
      candidates.push(i + 1)
    }
  }

  if (candidates.length === 0) return -1

  const preferred = candidates.filter((index) => index <= rawLine.length * 0.7)
  return (preferred[preferred.length - 1] ?? candidates[candidates.length - 1]) ?? -1
}
