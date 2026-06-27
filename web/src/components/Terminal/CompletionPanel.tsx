// 补全浮动面板:光标下方/上方定位,↑/↓ 高亮选中项

import { useEffect, useState, type CSSProperties } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { CompletionPopupState } from '@/hooks/useCompletion'

interface CompletionPanelProps {
  popup: CompletionPopupState
  getTerminal: () => Terminal | null
  containerRef: React.RefObject<HTMLDivElement | null>
}

interface PixelPos {
  left: number
  top: number
  maxVisible: number
}

export function CompletionPanel({ popup, getTerminal, containerRef }: CompletionPanelProps) {
  const [pos, setPos] = useState<PixelPos | null>(null)

  useEffect(() => {
    if (!popup.open) {
      setPos(null)
      return
    }
    const terminal = getTerminal()
    const container = containerRef.current
    if (!terminal || !container) return

    const screen = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen) return
    const screenRect = screen.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const cols = terminal.cols
    const rows = terminal.rows
    if (cols <= 0 || rows <= 0) return

    const cellW = screenRect.width / cols
    const cellH = screenRect.height / rows
    if (cellW <= 0 || cellH <= 0) return

    const cursorX = terminal.buffer.active.cursorX
    const cursorY = terminal.buffer.active.cursorY
    const screenLeft = screenRect.left - containerRect.left
    const screenTop = screenRect.top - containerRect.top

    const itemH = cellH + 6
    const count = popup.suggestions.length
    const maxVisible = Math.min(count, 8)
    const estimatedH = maxVisible * itemH + 8

    const cursorRowTop = screenTop + cursorY * cellH
    const cursorRowBottom = screenTop + (cursorY + 1) * cellH
    const spaceBelow = rows * cellH - (cursorY + 1) * cellH

    let top: number
    if (spaceBelow >= estimatedH || cursorY < rows / 2) {
      top = cursorRowBottom + 4
    } else {
      top = cursorRowTop - estimatedH - 4
    }

    let left = screenLeft + cursorX * cellW
    // 防止右侧溢出
    const panelMaxW = 360
    if (left + panelMaxW > container.clientWidth) {
      left = Math.max(0, container.clientWidth - panelMaxW - 8)
    }

    setPos({ left, top, maxVisible })
  }, [popup.open, popup.suggestions, popup.selectedIndex, getTerminal, containerRef])

  if (!popup.open || popup.suggestions.length === 0 || !pos) return null

  const panelStyle: CSSProperties = {
    position: 'absolute',
    left: pos.left,
    top: pos.top,
    maxWidth: 360,
    maxHeight: pos.maxVisible * ( /* cellH approx */ 20 + 6) + 8,
    overflowY: 'auto',
    zIndex: 100,
    background: 'var(--bg-panel, #1e1e2e)',
    border: '1px solid var(--border, #313244)',
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 13,
    padding: 4,
    pointerEvents: 'none',
  }

  return (
    <div style={panelStyle} className="xctrl-completion-panel">
      {popup.suggestions.map((sug, i) => {
        const selected = i === popup.selectedIndex
        const icon = sug.type === 'command' ? '⌘' : sug.type === 'subcommand' ? '▸' : sug.type === 'option' ? '–' : '•'
        return (
          <div
            key={sug.name + i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '3px 8px',
              borderRadius: 4,
              background: selected ? 'var(--accent, rgba(137,180,250,0.18))' : 'transparent',
              color: 'var(--term-fg, #cdd6f4)',
            }}
          >
            <span style={{ opacity: 0.5, width: 16, fontSize: 11, flexShrink: 0 }}>{icon}</span>
            <span style={{ fontWeight: selected ? 600 : 400, flexShrink: 0 }}>{sug.name}</span>
            {sug.description && (
              <span style={{ opacity: 0.5, marginLeft: 'auto', fontSize: 11, fontFamily: 'ui-sans-serif, system-ui', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {sug.description}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
