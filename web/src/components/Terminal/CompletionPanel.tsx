import { useEffect, useRef, useState, type CSSProperties } from 'react'
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

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

const ICONS = {
  command: isMac ? '⌘' : '⌂',
  subcommand: '▸',
  option: '−',
  arg: '•',
} as const

const SOURCE_LABELS = {
  static: '静态',
  dynamic: '动态',
} as const

export function CompletionPanel({ popup, getTerminal, containerRef }: CompletionPanelProps) {
  const [pos, setPos] = useState<PixelPos | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

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

    const top = spaceBelow >= estimatedH || cursorY < rows / 2
      ? cursorRowBottom + 4
      : cursorRowTop - estimatedH - 4

    let left = screenLeft + cursorX * cellW
    const panelMaxW = 380
    if (left + panelMaxW > container.clientWidth) {
      left = Math.max(0, container.clientWidth - panelMaxW - 8)
    }

    setPos({ left, top, maxVisible })
  }, [popup.open, popup.suggestions, popup.selectedIndex, getTerminal, containerRef])

  useEffect(() => {
    if (!popup.open) return
    const panel = panelRef.current
    if (!panel) return
    const selected = panel.querySelector('[data-selected="true"]') as HTMLElement | null
    selected?.scrollIntoView({ block: 'nearest' })
  }, [popup.open, popup.selectedIndex])

  if (!popup.open || popup.suggestions.length === 0 || !pos) return null

  const panelStyle: CSSProperties = {
    position: 'absolute',
    left: pos.left,
    top: pos.top,
    maxWidth: 380,
    maxHeight: pos.maxVisible * 26 + 8,
    overflowY: 'auto',
    zIndex: 100,
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 13,
    padding: 4,
    pointerEvents: 'none',
  }

  return (
    <div ref={panelRef} style={panelStyle} className="xctrl-completion-panel">
      {popup.suggestions.map((suggestion, index) => {
        const selected = index === popup.selectedIndex
        const icon = ICONS[suggestion.type]
        return (
          <div
            key={`${suggestion.name}-${index}`}
            data-selected={selected ? 'true' : 'false'}
            data-idx={index}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '3px 8px',
              borderRadius: 4,
              background: selected ? 'color-mix(in srgb, var(--accent) 20%, transparent)' : 'transparent',
              color: 'var(--fg)',
            }}
          >
            <span style={{ color: selected ? 'var(--accent)' : 'var(--fg-4)', width: 16, fontSize: 11, flexShrink: 0 }}>{icon}</span>
            <span style={{ fontWeight: selected ? 600 : 400, flexShrink: 0, color: selected ? 'var(--accent)' : 'var(--fg-2)' }}>
              {suggestion.name}
            </span>
            {suggestion.origin && (
              <span
                style={{
                  fontSize: 10,
                  lineHeight: 1,
                  padding: '2px 5px',
                  borderRadius: 999,
                  color: selected ? 'var(--accent)' : 'var(--fg-4)',
                  background: selected
                    ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
                    : 'color-mix(in srgb, var(--fg) 8%, transparent)',
                  flexShrink: 0,
                }}
              >
                {SOURCE_LABELS[suggestion.origin]}
              </span>
            )}
            {suggestion.description && (
              <span
                style={{
                  color: 'var(--fg-4)',
                  marginLeft: 'auto',
                  fontSize: 11,
                  fontFamily: 'ui-sans-serif, system-ui',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {suggestion.description}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
