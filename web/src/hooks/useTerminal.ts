import { useEffect, useRef, useCallback } from 'react'
import { Terminal, type IBufferRange } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

interface UseTerminalOptions {
  containerRef: React.RefObject<HTMLDivElement | null>
  fontSize?: number
  fontFamily?: string
  onData?: (data: string) => void
}

export function useTerminal(options: UseTerminalOptions) {
  const { containerRef, fontSize = 14, fontFamily, onData } = options
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const onDataRef = useRef(onData)

  useEffect(() => {
    onDataRef.current = onData
  })

  // Create terminal once per container
  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      fontSize,
      fontFamily: fontFamily || "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      theme: {
        background: '#0A0A0A',
        foreground: '#A3A3A3',
        cursor: '#E5E5E5',
        selectionBackground: '#0070f3',
        selectionForeground: '#0A0A0A',
        black: '#333333',
        red: '#EF4444',
        green: '#22C55E',
        yellow: '#f5a623',
        blue: '#0070f3',
        magenta: '#eb367f',
        cyan: '#50e3c2',
        white: '#A3A3A3',
        brightBlack: '#525252',
        brightRed: '#EF4444',
        brightGreen: '#22C55E',
        brightYellow: '#f5a623',
        brightBlue: '#3291ff',
        brightMagenta: '#eb367f',
        brightCyan: '#50e3c2',
        brightWhite: '#EDEDED',
      },
      allowProposedApi: true,
      // We handle right-click copy/paste ourselves (Termius-style), so disable
      // xterm's built-in right-click word selection (defaults to true on macOS).
      rightClickSelectsWord: false,
      cursorBlink: true,
      scrollback: 10000,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)

    terminal.open(containerRef.current)
    fitAddon.fit()

    // Wait for fonts to finish loading before the final fit. xterm.js measures
    // character size immediately; if the real font hasn't loaded yet, the row
    // height is wrong and the terminal can render with a one-line offset.
    const fitTimeout = setTimeout(() => fitAddon.fit(), 100)
    document.fonts.ready.then(() => {
      fitAddon.fit()
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Use ref so the callback is always current without re-creating the terminal
    terminal.onData((data) => onDataRef.current?.(data))

    // Termius-style text selection and copy/paste:
    // - Drag to select (no auto-copy on release).
    // - Left-click on an existing selection copies it; left-click outside cancels.
    // - Right-click on an existing selection copies it and pastes into the shell.
    // - Right-click anywhere else pastes from the clipboard.
    //
    // xterm.js clears the selection inside its own mousedown handler (bubble
    // phase, registered on terminal.element during open()). We attach our
    // mousedown listener in the capture phase so it runs first, letting us
    // snapshot the selection before it gets cleared. We then do geometry-based
    // hit testing to tell "click on the selection" apart from "click outside".
    const terminalElement = terminal.element ?? containerRef.current

    // Convert a mouse event into 0-based [column, bufferRow] cell coordinates.
    const getBufferCell = (event: MouseEvent): [number, number] | undefined => {
      const screenEl = (terminal.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? terminal.element
      if (!screenEl) return undefined
      const rect = screenEl.getBoundingClientRect()
      const cellWidth = rect.width / terminal.cols
      const cellHeight = rect.height / terminal.rows
      if (cellWidth <= 0 || cellHeight <= 0) return undefined
      const style = window.getComputedStyle(screenEl)
      const leftPad = parseFloat(style.paddingLeft) || 0
      const topPad = parseFloat(style.paddingTop) || 0
      const cellX = Math.min(Math.max(Math.floor((event.clientX - rect.left - leftPad) / cellWidth), 0), terminal.cols - 1)
      const cellY = Math.min(Math.max(Math.floor((event.clientY - rect.top - topPad) / cellHeight), 0), terminal.rows - 1)
      return [cellX, cellY + terminal.buffer.active.viewportY]
    }

    // getSelectionPosition() returns selectionStart/End (a.k.a.
    // finalSelectionStart/End), which are 0-based buffer coordinates — the
    // IBufferCellPosition type claims 1-based, but the implementation is
    // actually 0-based (coords are decremented in _getMouseBufferCoords).
    // Normalize into 0-based [startX, startY, endX, endY] with start before end.
    const rangeToCells = (range: IBufferRange): [number, number, number, number] => {
      const sx = range.start.x
      const sy = range.start.y
      const ex = range.end.x
      const ey = range.end.y
      if (ey < sy || (ey === sy && ex < sx)) return [ex, ey, sx, sy]
      return [sx, sy, ex, ey]
    }

    // Test whether a 0-based buffer cell lies within a normalized selection range.
    const isCellInSelection = (
      cellX: number, cellY: number,
      startX: number, startY: number, endX: number, endY: number
    ): boolean => {
      return (cellY > startY && cellY < endY) ||
        (startY === endY && cellY === startY && cellX >= startX && cellX < endX) ||
        (startY < endY && cellY === endY && cellX < endX) ||
        (startY < endY && cellY === startY && cellX >= startX)
    }

    let downX = 0
    let downY = 0
    let selectionOnDown = ''
    let selectionRangeOnDown: [number, number, number, number] | undefined

    const handleMouseDown = (event: MouseEvent) => {
      // Capture phase: runs before xterm.js clears the selection on a left click.
      if (event.button !== 0) return
      downX = event.clientX
      downY = event.clientY
      const text = terminal.getSelection()
      const pos = terminal.getSelectionPosition()
      if (text && pos) {
        selectionOnDown = text
        selectionRangeOnDown = rangeToCells(pos)
      } else {
        selectionOnDown = ''
        selectionRangeOnDown = undefined
      }
    }
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return
      const dx = event.clientX - downX
      const dy = event.clientY - downY
      const wasClick = Math.sqrt(dx * dx + dy * dy) <= 5
      const text = selectionOnDown
      const range = selectionRangeOnDown
      selectionOnDown = ''
      selectionRangeOnDown = undefined
      // A drag created/extended a selection — keep it, no auto-copy on release.
      if (!wasClick) return
      // Left-click on the existing selection -> copy. xterm.js already cleared
      // the highlight on mousedown, so there is nothing to clear here.
      if (text && range) {
        const cell = getBufferCell(event)
        if (cell) {
          const [sx, sy, ex, ey] = range
          if (isCellInSelection(cell[0], cell[1], sx, sy, ex, ey)) {
            navigator.clipboard.writeText(text).catch(() => {})
          }
        }
      }
    }
    const handleContextMenu = (event: MouseEvent) => {
      // Take over right-click: suppress the native menu and xterm's own
      // right-click handler (which moves its hidden textarea and would, on
      // macOS, select the word under the cursor).
      event.preventDefault()
      event.stopImmediatePropagation()
      const text = terminal.getSelection()
      const pos = terminal.getSelectionPosition()
      const cell = getBufferCell(event)
      let inside = false
      if (text && pos && cell) {
        const [sx, sy, ex, ey] = rangeToCells(pos)
        inside = isCellInSelection(cell[0], cell[1], sx, sy, ex, ey)
      }
      if (inside && text) {
        // Right-click on the selection: copy it and paste into the command line.
        navigator.clipboard.writeText(text).catch(() => {})
        terminal.input(text)
        terminal.clearSelection()
        return
      }
      // Right-click elsewhere: drop any stale highlight, then paste.
      terminal.clearSelection()
      navigator.clipboard.readText().then((clip) => {
        if (clip) terminal.input(clip)
      }).catch(() => {})
    }
    terminalElement?.addEventListener('mousedown', handleMouseDown, true)
    terminalElement?.addEventListener('mouseup', handleMouseUp)
    terminalElement?.addEventListener('contextmenu', handleContextMenu, true)

    const handleResize = () => {
      fitAddon.fit()
    }
    window.addEventListener('resize', handleResize)

    return () => {
      clearTimeout(fitTimeout)
      window.removeEventListener('resize', handleResize)
      terminalElement?.removeEventListener('mousedown', handleMouseDown, true)
      terminalElement?.removeEventListener('mouseup', handleMouseUp)
      terminalElement?.removeEventListener('contextmenu', handleContextMenu, true)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [containerRef]) // only re-create when container changes

  // Update font settings without recreating terminal
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
    terminal.options.fontFamily = fontFamily || "'JetBrains Mono', 'Fira Code', ui-monospace, monospace"
    fitAddonRef.current?.fit()
  }, [fontSize, fontFamily])

  const write = useCallback((data: string) => {
    terminalRef.current?.write(data)
  }, [])

  const writeln = useCallback((data: string) => {
    terminalRef.current?.writeln(data)
  }, [])

  const clear = useCallback(() => {
    terminalRef.current?.clear()
  }, [])

  const reset = useCallback(() => {
    terminalRef.current?.reset()
  }, [])

  const fit = useCallback(() => {
    fitAddonRef.current?.fit()
  }, [])

  const getSize = useCallback(() => {
    const terminal = terminalRef.current
    if (!terminal) return { cols: 80, rows: 24 }
    return { cols: terminal.cols, rows: terminal.rows }
  }, [])

  return {
    write,
    writeln,
    clear,
    reset,
    fit,
    getSize,
  }
}
