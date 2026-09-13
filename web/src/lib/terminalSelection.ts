import type { IBufferRange, Terminal } from '@xterm/xterm'

export interface BufferCell {
  x: number
  y: number
}

export interface ScreenMetrics {
  rect: DOMRect
  cellWidth: number
  cellHeight: number
  viewportY: number
}

export interface SelectionClientRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface TerminalSelectionSpec {
  column: number
  row: number
  length: number
}

export function screenElementOf(terminal: Terminal): HTMLElement | null {
  return terminal.element?.querySelector('.xterm-screen') as HTMLElement | null
}

export function terminalScreenMetrics(terminal: Terminal): ScreenMetrics | null {
  const screen = screenElementOf(terminal)
  if (!screen || terminal.cols <= 0 || terminal.rows <= 0) return null
  const rect = screen.getBoundingClientRect()
  const cellWidth = rect.width / terminal.cols
  const cellHeight = rect.height / terminal.rows
  if (cellWidth <= 0 || cellHeight <= 0) return null
  return {
    rect,
    cellWidth,
    cellHeight,
    viewportY: terminal.buffer.active.viewportY,
  }
}

export function inclusiveSelectionEnd(range: IBufferRange, cols: number): BufferCell {
  if (range.end.x > 0) return { x: range.end.x - 1, y: range.end.y }
  return { x: cols - 1, y: Math.max(range.start.y, range.end.y - 1) }
}

/** 把两个包含端点规范化为 xterm.select 所需的起点和跨行长度。 */
export function selectionSpecFromInclusiveCells(
  first: BufferCell,
  second: BufferCell,
  cols: number,
): TerminalSelectionSpec {
  const firstIndex = first.y * cols + first.x
  const secondIndex = second.y * cols + second.x
  const startIndex = Math.min(firstIndex, secondIndex)
  const endIndex = Math.max(firstIndex, secondIndex)
  return {
    column: startIndex % cols,
    row: Math.floor(startIndex / cols),
    length: endIndex - startIndex + 1,
  }
}

/** 当前选区的屏幕包围盒，供长按菜单选择上/下避让位置。 */
export function getTerminalSelectionClientRect(terminal: Terminal | null): SelectionClientRect | undefined {
  const range = terminal?.getSelectionPosition()
  if (!terminal || !range) return undefined
  const metrics = terminalScreenMetrics(terminal)
  if (!metrics) return undefined
  const end = inclusiveSelectionEnd(range, terminal.cols)
  const startRow = range.start.y - metrics.viewportY
  const endRow = end.y - metrics.viewportY
  const top = metrics.rect.top + startRow * metrics.cellHeight
  const bottom = metrics.rect.top + (endRow + 1) * metrics.cellHeight
  const multiLine = end.y > range.start.y
  return {
    left: multiLine ? metrics.rect.left : metrics.rect.left + range.start.x * metrics.cellWidth,
    top: Math.max(metrics.rect.top, top),
    right: multiLine ? metrics.rect.right : metrics.rect.left + (end.x + 1) * metrics.cellWidth,
    bottom: Math.min(metrics.rect.bottom, bottom),
  }
}
