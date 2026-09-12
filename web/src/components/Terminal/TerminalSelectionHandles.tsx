import { useCallback, useEffect, useRef, useState } from 'react'

import type { Terminal } from '@xterm/xterm'

interface TerminalSelectionHandlesProps {
  getTerminal: () => Terminal | null
  /** 终端宿主容器（手柄定位基准） */
  hostRef: React.RefObject<HTMLElement | null>
}

interface SelectionRects {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

const HANDLE_SIZE = 22

function dispatchMouse(element: Element, type: 'mousedown' | 'mousemove' | 'mouseup', x: number, y: number, buttons: number) {
  element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: 1,
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
    }),
  )
}

/**
 * 移动端终端选区手柄：双击选词后显示两个可拖动水滴（仿系统文本选择器）。
 * 拖动通过合成 mouse 事件驱动 xterm SelectionService，天然支持跨行选区。
 * canvas 终端无法使用系统选择器，此为替代实现。仅移动端渲染；
 * 滚动/选区消失时自动隐藏。
 */
export function TerminalSelectionHandles({ getTerminal, hostRef }: TerminalSelectionHandlesProps) {
  const [rects, setRects] = useState<SelectionRects | null>(null)
  const draggingRef = useRef<'start' | 'end' | null>(null)

  const screenElOf = useCallback(() => getTerminal()?.element?.querySelector('.xterm-screen') as HTMLElement | null, [getTerminal])

  /** 由 xterm 选区（buffer 坐标）计算两个手柄在 host 内的像素位置 */
  const syncRects = useCallback(() => {
    const terminal = getTerminal()
    const host = hostRef.current
    const screen = screenElOf()
    if (!terminal || !host || !screen || !terminal.hasSelection()) {
      setRects(null)
      return
    }
    const sel = terminal.getSelectionPosition()
    if (!sel) {
      setRects(null)
      return
    }
    const hostRect = host.getBoundingClientRect()
    const screenRect = screen.getBoundingClientRect()
    const cellWidth = screenRect.width / terminal.cols
    const cellHeight = screenRect.height / terminal.rows
    if (cellWidth <= 0 || cellHeight <= 0) {
      setRects(null)
      return
    }
    const viewportY = terminal.buffer.active.viewportY
    const baseX = screenRect.left - hostRect.left
    const baseY = screenRect.top - hostRect.top
    setRects({
      // 起点手柄：选区首单元格左上；终点手柄：末单元格右下（end.x 为排他列）
      start: { x: baseX + sel.start.x * cellWidth, y: baseY + (sel.start.y - viewportY) * cellHeight },
      end: { x: baseX + sel.end.x * cellWidth, y: baseY + (sel.end.y - viewportY + 1) * cellHeight },
    })
  }, [getTerminal, hostRef, screenElOf])

  // xterm 在组件挂载后才由 useTerminal 创建，rAF 重试直到实例可用再挂事件
  useEffect(() => {
    let raf = 0
    let disposed = false
    let disposers: Array<{ dispose: () => void }> = []
    const tryAttach = () => {
      if (disposed) return
      const terminal = getTerminal()
      if (!terminal) {
        raf = requestAnimationFrame(tryAttach)
        return
      }
      disposers = [
        terminal.onSelectionChange(syncRects),
        terminal.onScroll(() => setRects(null)),
      ]
    }
    tryAttach()
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      disposers.forEach((d) => d.dispose())
    }
  }, [getTerminal, syncRects])

  /** 合成 mouse 序列的锚点：固定选区的另一端（拖起手柄锚在旧终点，反之亦然） */
  const anchorFor = useCallback(
    (which: 'start' | 'end'): { x: number; y: number } | null => {
      const terminal = getTerminal()
      const screen = screenElOf()
      const sel = terminal?.getSelectionPosition()
      if (!terminal || !screen || !sel) return null
      const rect = screen.getBoundingClientRect()
      const cellWidth = rect.width / terminal.cols
      const cellHeight = rect.height / terminal.rows
      const viewportY = terminal.buffer.active.viewportY
      if (which === 'start') {
        // 锚在当前选区终点（排他列 - 1 即最后一个被选中的单元格）
        return {
          x: rect.left + (sel.end.x - 0.5) * cellWidth,
          y: rect.top + (sel.end.y - viewportY + 0.5) * cellHeight,
        }
      }
      return {
        x: rect.left + (sel.start.x + 0.5) * cellWidth,
        y: rect.top + (sel.start.y - viewportY + 0.5) * cellHeight,
      }
    },
    [getTerminal, screenElOf],
  )

  const handlePointerDown = useCallback(
    (which: 'start' | 'end', event: React.PointerEvent<HTMLDivElement>) => {
      const terminal = getTerminal()
      const screen = screenElOf()
      const anchor = anchorFor(which)
      if (!terminal || !screen || !anchor) return
      event.preventDefault()
      event.stopPropagation()
      draggingRef.current = which
      event.currentTarget.setPointerCapture(event.pointerId)
      // mousedown 在固定端起步，后续 mousemove 由 xterm 自行扩展选区（支持跨行）
      dispatchMouse(screen, 'mousedown', anchor.x, anchor.y, 1)
    },
    [anchorFor, getTerminal, screenElOf],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const screen = screenElOf()
      if (!screen || !draggingRef.current) return
      dispatchMouse(screen, 'mousemove', event.clientX, event.clientY, 1)
    },
    [screenElOf],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const screen = screenElOf()
      if (!screen || !draggingRef.current) return
      draggingRef.current = null
      dispatchMouse(screen, 'mouseup', event.clientX, event.clientY, 0)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    [screenElOf],
  )

  if (!rects) return null

  return (
    <div className="m-term-select-layer" aria-hidden="true">
      <div
        className="m-term-handle is-start"
        style={{
          left: rects.start.x - HANDLE_SIZE / 2,
          top: rects.start.y - HANDLE_SIZE + 4,
        }}
        onPointerDown={(event) => handlePointerDown('start', event)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      <div
        className="m-term-handle is-end"
        style={{
          left: rects.end.x - HANDLE_SIZE / 2,
          top: rects.end.y - 4,
        }}
        onPointerDown={(event) => handlePointerDown('end', event)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  )
}
