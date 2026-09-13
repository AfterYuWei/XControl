import { useCallback, useEffect, useRef, useState } from 'react'

import type { Terminal } from '@xterm/xterm'
import {
  inclusiveSelectionEnd,
  screenElementOf,
  selectionSpecFromInclusiveCells,
  terminalScreenMetrics,
  type BufferCell,
  type ScreenMetrics,
} from '@/lib/terminalSelection'

interface TerminalSelectionHandlesProps {
  getTerminal: () => Terminal | null
  /** 终端宿主容器（手柄定位基准） */
  hostRef: React.RefObject<HTMLElement | null>
}

interface HandlePoint {
  x: number
  y: number
  visible: boolean
}

interface SelectionRects {
  start: HandlePoint
  end: HandlePoint
}

const HANDLE_HIT_SIZE = 36
const HANDLE_ATTACH_Y = 4

function handleClientPoint(
  cell: BufferCell,
  edge: 'start' | 'end',
  metrics: ScreenMetrics,
): { x: number; y: number } {
  return {
    x: metrics.rect.left + (cell.x + (edge === 'end' ? 1 : 0)) * metrics.cellWidth,
    y: metrics.rect.top + (cell.y - metrics.viewportY + 1) * metrics.cellHeight,
  }
}

function cellFromHandlePoint(
  clientX: number,
  clientY: number,
  edge: 'start' | 'end',
  terminal: Terminal,
  metrics: ScreenMetrics,
): BufferCell {
  const relativeX = clientX - metrics.rect.left
  const relativeY = clientY - metrics.rect.top
  const rawColumn = edge === 'start'
    ? Math.floor(relativeX / metrics.cellWidth)
    : Math.ceil(relativeX / metrics.cellWidth) - 1
  const rawScreenRow = Math.ceil(relativeY / metrics.cellHeight) - 1
  return {
    x: Math.min(Math.max(rawColumn, 0), terminal.cols - 1),
    y: Math.min(
      Math.max(rawScreenRow, 0),
      terminal.rows - 1,
    ) + metrics.viewportY,
  }
}

/**
 * 移动端终端选区手柄。拖动时直接把触点换算成 xterm buffer 坐标，
 * 以另一端为固定锚点调用 terminal.select，因此跨行选择不依赖浏览器合成鼠标事件。
 */
export function TerminalSelectionHandles({ getTerminal, hostRef }: TerminalSelectionHandlesProps) {
  const [rects, setRects] = useState<SelectionRects | null>(null)
  const draggingRef = useRef<'start' | 'end' | null>(null)
  const fixedCellRef = useRef<BufferCell | null>(null)
  const grabOffsetRef = useRef({ x: 0, y: 0 })

  const syncRects = useCallback(() => {
    const terminal = getTerminal()
    const host = hostRef.current
    const range = terminal?.getSelectionPosition()
    if (!terminal || !host || !range || !terminal.hasSelection()) {
      setRects(null)
      return
    }
    const metrics = terminalScreenMetrics(terminal)
    if (!metrics) {
      setRects(null)
      return
    }
    const hostRect = host.getBoundingClientRect()
    const end = inclusiveSelectionEnd(range, terminal.cols)
    const startClient = handleClientPoint(range.start, 'start', metrics)
    const endClient = handleClientPoint(end, 'end', metrics)
    const visible = (point: { x: number; y: number }) => (
      point.y >= metrics.rect.top - 1 && point.y <= metrics.rect.bottom + 1
    )
    setRects({
      start: {
        x: startClient.x - hostRect.left,
        y: startClient.y - hostRect.top,
        visible: visible(startClient),
      },
      end: {
        x: endClient.x - hostRect.left,
        y: endClient.y - hostRect.top,
        visible: visible(endClient),
      },
    })
  }, [getTerminal, hostRef])

  useEffect(() => {
    let raf = 0
    let disposed = false
    let disposers: Array<{ dispose: () => void }> = []
    let observer: ResizeObserver | undefined
    const tryAttach = () => {
      if (disposed) return
      const terminal = getTerminal()
      const host = hostRef.current
      const screen = terminal ? screenElementOf(terminal) : null
      if (!terminal || !host || !screen) {
        raf = requestAnimationFrame(tryAttach)
        return
      }
      disposers = [
        terminal.onSelectionChange(syncRects),
        terminal.onScroll(syncRects),
        terminal.onRender(syncRects),
      ]
      observer = new ResizeObserver(syncRects)
      observer.observe(host)
      observer.observe(screen)
      syncRects()
    }
    tryAttach()
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer?.disconnect()
      disposers.forEach((disposer) => disposer.dispose())
    }
  }, [getTerminal, hostRef, syncRects])

  const updateSelection = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const edge = draggingRef.current
    const fixed = fixedCellRef.current
    const terminal = getTerminal()
    if (!edge || !fixed || !terminal) return
    const metrics = terminalScreenMetrics(terminal)
    if (!metrics) return
    const moving = cellFromHandlePoint(
      event.clientX - grabOffsetRef.current.x,
      event.clientY - grabOffsetRef.current.y,
      edge,
      terminal,
      metrics,
    )
    const selection = selectionSpecFromInclusiveCells(fixed, moving, terminal.cols)
    terminal.select(selection.column, selection.row, selection.length)
  }, [getTerminal])

  const handlePointerDown = useCallback((
    edge: 'start' | 'end',
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const terminal = getTerminal()
    const range = terminal?.getSelectionPosition()
    if (!terminal || !range) return
    const metrics = terminalScreenMetrics(terminal)
    if (!metrics) return
    const start = { x: range.start.x, y: range.start.y }
    const end = inclusiveSelectionEnd(range, terminal.cols)
    const moving = edge === 'start' ? start : end
    const handlePoint = handleClientPoint(moving, edge, metrics)

    event.preventDefault()
    event.stopPropagation()
    draggingRef.current = edge
    fixedCellRef.current = edge === 'start' ? end : start
    grabOffsetRef.current = {
      x: event.clientX - handlePoint.x,
      y: event.clientY - handlePoint.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [getTerminal])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    updateSelection(event)
    draggingRef.current = null
    fixedCellRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [updateSelection])

  if (!rects) return null

  const renderHandle = (edge: 'start' | 'end', point: HandlePoint) => point.visible && (
    <div
      className={`m-term-handle is-${edge}`}
      style={{
        left: point.x - HANDLE_HIT_SIZE / 2,
        top: point.y - HANDLE_ATTACH_Y,
      }}
      aria-hidden="true"
      onPointerDown={(event) => handlePointerDown(edge, event)}
      onPointerMove={updateSelection}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  )

  return (
    <div className="m-term-select-layer" aria-hidden="true">
      {renderHandle('start', rects.start)}
      {renderHandle('end', rects.end)}
    </div>
  )
}
