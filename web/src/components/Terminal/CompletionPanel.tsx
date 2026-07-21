import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { CompletionPopupState } from '@/hooks/useCompletion'
import type { Suggestion } from '@/lib/completionSpecs'

interface CompletionPanelProps {
  popup: CompletionPopupState
  getTerminal: () => Terminal | null
  containerRef: React.RefObject<HTMLDivElement | null>
  /** 鼠标悬停选中某项（级联模式下由面板触发） */
  onHoverItem?: (columnIndex: number, itemIndex: number) => void
  /** 鼠标点击某项（应用选择） */
  onClickItem?: (columnIndex: number, itemIndex: number) => void
  /** 悬停目录项时请求展开子菜单 */
  onExpandDir?: () => void
}

interface PixelPos {
  left: number
  top: number
  cellH: number
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

const ICONS = {
  command: isMac ? '⌘' : '⌂',
  subcommand: '▸',
  option: '−',
  arg: '•',
  directory: '▸',
  file: '·',
  history: 'H',
} as const

const SOURCE_LABELS = {
  static: '静态',
  dynamic: '动态',
} as const

const COLUMN_WIDTH = 260
const COLUMN_GAP = 4
const ROW_H = 26
const HOVER_EXPAND_MS = 200

export function CompletionPanel({ popup, getTerminal, containerRef, onHoverItem, onClickItem, onExpandDir }: CompletionPanelProps) {
  const [pos, setPos] = useState<PixelPos | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 定位：基于 xterm 光标像素坐标。第一列在光标下方，后续列向右依次排开。
  // 仅在打开时计算并写 pos；关闭时由渲染分支 (!popup.open) 直接返回 null，
  // 无需在 effect 里同步重置 pos。
  useEffect(() => {
    if (!popup.open) return

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

    const columnCount = popup.columns.length
    const panelW = columnCount * COLUMN_WIDTH + (columnCount - 1) * COLUMN_GAP + 8
    const itemH = cellH + 6
    const maxVisible = 8
    const estimatedH = maxVisible * itemH + 8

    const cursorRowTop = screenTop + cursorY * cellH
    const cursorRowBottom = screenTop + (cursorY + 1) * cellH
    const spaceBelow = rows * cellH - (cursorY + 1) * cellH

    const top = spaceBelow >= estimatedH || cursorY < rows / 2
      ? cursorRowBottom + 4
      : cursorRowTop - estimatedH - 4

    let left = screenLeft + cursorX * cellW
    if (left + panelW > container.clientWidth) {
      left = Math.max(0, container.clientWidth - panelW - 8)
    }

    setPos({ left, top, cellH })
  }, [popup.open, popup.columns, getTerminal, containerRef])

  // 键盘导航时滚动到选中项
  useEffect(() => {
    if (!popup.open) return
    const panel = panelRef.current
    if (!panel) return
    const selected = panel.querySelector('[data-selected="true"]') as HTMLElement | null
    selected?.scrollIntoView({ block: 'nearest' })
  }, [popup.open, popup.columns, popup.activeColumn])

  // 清理悬停定时器
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    }
  }, [])

  if (!popup.open || popup.columns.length === 0 || !pos) return null

  const handleHover = (columnIndex: number, itemIndex: number, suggestion: Suggestion) => {
    onHoverItem?.(columnIndex, itemIndex)
    // 级联模式：悬停目录项 200ms 后自动展开子菜单
    if (popup.cascade && suggestion.type === 'directory' && suggestion.isDir) {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(() => {
        onExpandDir?.()
      }, HOVER_EXPAND_MS)
    } else if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }

  const containerStyle: CSSProperties = {
    position: 'absolute',
    left: pos.left,
    top: pos.top,
    display: 'flex',
    gap: COLUMN_GAP,
    zIndex: 100,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 13,
  }

  return (
    <div ref={panelRef} style={containerStyle} className="xctrl-completion-panel">
      {popup.columns.map((column, columnIndex) => {
        const isActiveCol = columnIndex === popup.activeColumn
        return (
          <div
            key={columnIndex}
            style={{
              width: COLUMN_WIDTH,
              maxHeight: 8 * ROW_H + 8,
              overflowY: 'auto',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              padding: 4,
            }}
          >
            {column.suggestions.map((suggestion, itemIndex) => {
              // 该列的选中项总是高亮（标识"从这一项进入下一级"），
              // 活动列（键盘焦点所在列）用强高亮，父级来源列用弱高亮。
              const selectedInColumn = itemIndex === column.selectedIndex
              return (
                <CompletionRow
                  key={`${suggestion.name}-${itemIndex}`}
                  suggestion={suggestion}
                  selected={selectedInColumn}
                  active={isActiveCol}
                  onHover={() => handleHover(columnIndex, itemIndex, suggestion)}
                  onClick={() => onClickItem?.(columnIndex, itemIndex)}
                />
              )
            })}
            {column.suggestions.length === 0 && (
              <div style={{ padding: '6px 10px', color: 'var(--fg-4)', fontSize: 12 }}>无子目录</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface CompletionRowProps {
  suggestion: Suggestion
  /** 是否为该列的选中项（用于高亮来源路径） */
  selected: boolean
  /** 是否为键盘焦点所在列（决定高亮强弱） */
  active: boolean
  onHover: () => void
  onClick: () => void
}

function CompletionRow({ suggestion, selected, active, onHover, onClick }: CompletionRowProps) {
  const isDir = suggestion.type === 'directory' && suggestion.isDir
  const isFile = suggestion.type === 'directory' && !suggestion.isDir
  const isHistory = suggestion.type === 'history'
  // 末级目录/文件只显示当前段名（displayName），不显示冗长完整路径
  const label = suggestion.displayName ?? suggestion.name
  const icon = isHistory ? ICONS.history : isDir ? ICONS.directory : isFile ? ICONS.file : ICONS[suggestion.type]

  // 活动列的选中项用强高亮（accent），父级来源列的选中项用弱高亮（表示路径来源）
  const strongHighlight = selected && active
  const weakHighlight = selected && !active

  return (
    <div
      data-selected={selected ? 'true' : 'false'}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: ROW_H - 6,
        padding: '3px 8px',
        borderRadius: 4,
        cursor: 'pointer',
        background: strongHighlight
          ? 'color-mix(in srgb, var(--accent) 20%, transparent)'
          : weakHighlight
            ? 'color-mix(in srgb, var(--accent) 9%, transparent)'
            : 'transparent',
        color: 'var(--fg)',
      }}
    >
      <span
        style={{
          width: 16,
          fontSize: 10,
          flexShrink: 0,
          textAlign: 'center',
          color: isHistory ? 'var(--yellow, #f5a623)' : strongHighlight ? 'var(--accent)' : 'var(--fg-4)',
          fontWeight: isHistory ? 700 : 400,
          fontStyle: isHistory ? 'italic' : 'normal',
          fontFamily: isHistory ? 'ui-sans-serif, system-ui' : 'inherit',
        }}
      >
        {icon}
      </span>
      <span
        style={{
          fontWeight: selected ? 600 : 400,
          color: strongHighlight ? 'var(--accent)' : selected ? 'var(--fg)' : 'var(--fg-2)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {label}
      </span>
      {isHistory && suggestion.count !== undefined && suggestion.count > 1 && (
        <span style={{ fontSize: 10, color: 'var(--fg-4)', flexShrink: 0 }}>×{suggestion.count}</span>
      )}
      {suggestion.origin && suggestion.type !== 'directory' && !isHistory && (
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
      {isDir && (
        <span style={{ marginLeft: 'auto', color: 'var(--fg-4)', fontSize: 11, flexShrink: 0 }}>›</span>
      )}
    </div>
  )
}
