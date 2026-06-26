import { useEffect, useRef, useCallback, useState } from 'react'
import { useTerminal } from '@/hooks/useTerminal'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import type { WSMessage, MetaPayload, ErrorPayload, CwdPayload } from '@/types/ws'

type WSStatus = 'connecting' | 'connected' | 'disconnected'

interface TerminalPaneProps {
  tab: {
    id: string
    profileId: string
    profileName: string
    sessionId: string | null
    status: 'connecting' | 'connected' | 'disconnected'
    host?: string
    port?: number
    username?: string
  }
  isActive: boolean
}

export function TerminalPane({ tab, isActive }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { updateTabStatus, updateTabCwd, updateTabLatency } = useSessionStore()
  const { fontSize, fontFamily } = useSettingsStore()
  const [showDialog, setShowDialog] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [dialogStatus, setDialogStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const hasSpecificError = useRef(false)

  const wsStatusRef = useRef<WSStatus>('connecting')
  const sendInputRef = useRef<(data: string) => void>(() => {})
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {})

  const { write, writeln, clear, reset, fit, getSize } = useTerminal({
    containerRef,
    fontSize,
    fontFamily,
    onData: (data) => {
      if (tab.sessionId && wsStatusRef.current === 'connected') {
        sendInputRef.current(data)
      }
    },
  })

  const handleWSMessage = useCallback(
    (msg: WSMessage) => {
      switch (msg.type) {
        case 'output':
          if (msg.data) {
            write(msg.data)
          }
          break
        case 'metadata': {
          const meta = msg.payload as MetaPayload
          reset()
          clear()
          updateTabStatus(tab.id, 'connected', meta.session_id)
          setDialogStatus('connected')
          setTimeout(() => setShowDialog(false), 500)
          break
        }
        case 'cwd': {
          const cwd = msg.payload as CwdPayload
          if (cwd?.path) {
            updateTabCwd(tab.id, cwd.path)
          }
          break
        }
        case 'exit':
          updateTabStatus(tab.id, 'disconnected')
          writeln('\r\n\x1b[33m[会话已结束]\x1b[0m')
          break
        case 'error': {
          const err = msg.payload as ErrorPayload
          hasSpecificError.current = true
          setConnectionError(err.message)
          setDialogStatus('error')
          updateTabStatus(tab.id, 'disconnected')
          break
        }
      }
    },
    [tab.id, updateTabStatus, updateTabCwd, write, writeln, clear, reset]
  )

  const { status: wsStatus, latency, sendInput, sendResize } = useWebSocket({
    sessionId: tab.sessionId || '',
    onMessage: handleWSMessage,
    onOpen: () => {
      // Delay to ensure terminal layout is complete before reading size
      setTimeout(() => {
        fit()
        const { cols, rows } = getSize()
        sendResizeRef.current(cols, rows)
      }, 50)
    },
    onError: () => {
      if (!hasSpecificError.current) {
        setConnectionError('无法连接到服务器')
      }
    },
  })

  useEffect(() => {
    wsStatusRef.current = wsStatus
    sendInputRef.current = sendInput
    sendResizeRef.current = sendResize
  }, [wsStatus, sendInput, sendResize])

  // Sync latency to session store
  useEffect(() => {
    if (latency !== null) {
      updateTabLatency(tab.id, latency)
    }
  }, [latency, tab.id, updateTabLatency])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (tab.status === 'connecting' && tab.sessionId) {
      setShowDialog(true)
      setDialogStatus('connecting')
      setConnectionError('')
      hasSpecificError.current = false
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [tab.status, tab.sessionId])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (wsStatus === 'disconnected' && tab.status === 'connecting' && !hasSpecificError.current) {
      setConnectionError('无法连接到服务器')
      setDialogStatus('error')
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [wsStatus, tab.status])

  useEffect(() => {
    if (!isActive) return

    // Explicitly fit when the pane becomes visible; otherwise a terminal created
    // while the pane was hidden (display: none) can leave a clipped/offset top row.
    fit()

    const observer = new ResizeObserver(() => {
      fit()
      const { cols, rows } = getSize()
      if (tab.sessionId && wsStatusRef.current === 'connected') {
        sendResizeRef.current(cols, rows)
      }
    })

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => observer.disconnect()
  }, [isActive, tab.sessionId, fit, getSize])

  const handleCancel = () => {
    updateTabStatus(tab.id, 'disconnected')
  }

  return (
    <div className="h-full w-full relative" style={{ background: 'var(--term-bg)' }}>
      <div ref={containerRef} className="h-full w-full" />

      <ConnectionDialog
        key={showDialog ? tab.id : 'closed'}
        open={showDialog}
        onOpenChange={setShowDialog}
        profileName={tab.profileName}
        host={tab.host || '未知'}
        port={tab.port || 22}
        username={tab.username || 'root'}
        status={dialogStatus}
        errorMessage={connectionError}
        onCancel={handleCancel}
      />
    </div>
  )
}
