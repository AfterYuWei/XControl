// 补全输入缓冲区管理:prompt 剥离、stale 恢复、行内光标追踪
// 设计原则:只处理 fresh 输入行,遇到复杂场景宁可降级为 stale 也不误导补全

import type { Terminal } from '@xterm/xterm'

export interface BufferState {
  text: string
  cursor: number
  stale: boolean
}

// 常见 TUI 命令前缀:启动这些命令后进入 alternate buffer 或接管键盘
// 注意:只要命令名匹配即可,vim file.txt / htop -d 10 都应禁用
const TUI_START_COMMANDS = new Set([
  'vim', 'vi', 'nvim', 'nano', 'emacs',
  'htop', 'top', 'btop', 'gtop',
  'less', 'more', 'most',
  'tmux', 'screen',
  'fzf',
])

// 判断一段用户输入是否为"启动 TUI"的命令行
export function isTuiCommand(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  const first = trimmed.split(/\s+/)[0]
  // 支持 sudo vim / /usr/bin/vim 等前缀
  const base = first.replace(/.*\//, '')
  return TUI_START_COMMANDS.has(base)
}

// 通过控制序列判断终端是否进入/退出 alternate buffer
// 进入:ESC [ ?1049 h ; 退出:ESC [ ?1049 l (或 ESC [ ?1047 h/l 为旧版)
export function detectTuiSequence(data: string): 'enter' | 'exit' | null {
  if (data.includes('\x1b[?1049h') || data.includes('\x1b[?1047h')) return 'enter'
  if (data.includes('\x1b[?1049l') || data.includes('\x1b[?1047l')) return 'exit'
  return null
}

// 从 xterm buffer 当前行提取用户输入
// 返回 { text, promptEnd } ; text 为剥离 prompt 后的输入,promptEnd 为 prompt 在 rawLine 中的结束索引(不含)
export function extractInputFromLine(rawLine: string): { text: string; promptEnd: number } {
  if (!rawLine) return { text: '', promptEnd: -1 }

  // 策略:从右向左扫描,找到最后一个 prompt 结束符
  // 结束符定义:字符串末尾的 $/#/%/> 后接空格或无内容
  // 同时要求结束符位于行的后半部分,避免路径中的 $ 被误判
  let bestIdx = -1
  const len = rawLine.length
  for (let i = len - 1; i >= 0; i--) {
    const ch = rawLine[i]
    if (ch === '$' || ch === '#' || ch === '%' || ch === '>') {
      // 结束符后必须是空格或行尾
      const after = i + 1
      if (after >= len || rawLine[after] === ' ') {
        bestIdx = i
        break
      }
    }
  }

  if (bestIdx === -1) {
    // 没找到结束符:整行当作用户输入(可能是极简 prompt 或无 prompt)
    return { text: rawLine.trimStart(), promptEnd: 0 }
  }

  // 防御:如果结束符在很靠前的位置(比如前 30%),可能是路径中的 $ 等字符
  // 这种情况下取整行最开始的非空格作为 prompt 结束(即尽量取最后的合理 prompt)
  if (bestIdx < len * 0.3) {
    // 尝试找第二个候选(从 bestIdx 左边继续扫)
    let second = -1
    for (let i = bestIdx - 1; i >= 0; i--) {
      const ch = rawLine[i]
      if (ch === '$' || ch === '#' || ch === '%' || ch === '>') {
        const after = i + 1
        if (after >= len || rawLine[after] === ' ') {
          second = i
          break
        }
      }
    }
    if (second !== -1) {
      bestIdx = second
    }
  }

  const text = rawLine.slice(bestIdx + 1).trimStart()
  return { text, promptEnd: bestIdx + 1 }
}

// 从 terminal buffer 读取当前行并提取输入
export function resyncFromTerminal(getTerminal: () => Terminal | null): BufferState {
  const terminal = getTerminal()
  if (!terminal) {
    return { text: '', cursor: 0, stale: false }
  }
  const buf = terminal.buffer.active
  const rawLine = buf.getLine(buf.cursorY)?.translateToString(true) ?? ''
  const { text } = extractInputFromLine(rawLine)
  return { text, cursor: text.length, stale: false }
}

// 在 fresh 输入行内移动光标,不触发 stale
export function moveCursorInBuffer(state: BufferState, delta: number): boolean {
  if (state.stale) return false
  const next = state.cursor + delta
  if (next < 0 || next > state.text.length) return false
  state.cursor = next
  return true
}
