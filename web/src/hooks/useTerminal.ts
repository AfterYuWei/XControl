import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
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
  onDataRef.current = onData

  // Create terminal once per container
  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      fontSize,
      fontFamily: fontFamily || 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#7aa2f7',
        selectionForeground: '#15161e',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      allowProposedApi: true,
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

    const handleResize = () => {
      fitAddon.fit()
    }
    window.addEventListener('resize', handleResize)

    return () => {
      clearTimeout(fitTimeout)
      window.removeEventListener('resize', handleResize)
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
    terminal.options.fontFamily = fontFamily || 'Menlo, Monaco, "Courier New", monospace'
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
    terminal: terminalRef.current,
    write,
    writeln,
    clear,
    reset,
    fit,
    getSize,
  }
}
